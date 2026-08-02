#!/usr/bin/env python3
"""Upload Yield subscription review screenshots to App Store Connect."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

import jwt


API_BASE = "https://api.appstoreconnect.apple.com"
SUBSCRIPTIONS = {
    "6797232006": "equity",
    "6797231871": "equity-pro",
    "6797231801": "options",
    "6797231900": "options-pro",
}
SCREENSHOT = Path(
    "apps/ios/Documentation/QA/2026-08-01/visual-review/onboarding/"
    "6A19087F-6431-4D4F-84F4-CE3EBC0482B9.png"
)


def access_token() -> str:
    private_key = Path(os.environ["ASC_PRIVATE_KEY_PATH"]).read_text(encoding="utf-8")
    now = int(time.time())
    return jwt.encode(
        {
            "iss": os.environ["ASC_ISSUER_ID"],
            "iat": now - 5,
            "exp": now + 1_100,
            "aud": "appstoreconnect-v1",
        },
        private_key,
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


def api_request(
    token: str, method: str, path: str, body: dict | None = None, allowed_errors: set[int] | None = None
) -> dict:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        API_BASE + path,
        data=encoded,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read()
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        if allowed_errors is not None and error.code in allowed_errors:
            return {"errorStatus": error.code, "errorDetail": detail}
        raise RuntimeError(f"App Store Connect returned HTTP {error.code}: {detail}") from error


def ensure_subscription_availability(token: str, subscription_id: str) -> None:
    territories = api_request(token, "GET", "/v1/territories?limit=200")["data"]
    territory_links = [
        {"type": "territories", "id": territory["id"]} for territory in territories
    ]
    response = api_request(
        token,
        "GET",
        f"/v1/subscriptions/{subscription_id}/subscriptionAvailability",
        allowed_errors={404},
    )
    availability = response.get("data")
    relationships = {
        "subscription": {"data": {"type": "subscriptions", "id": subscription_id}},
        "availableTerritories": {"data": territory_links},
    }
    if availability is None:
        api_request(
            token,
            "POST",
            "/v1/subscriptionAvailabilities",
            {
                "data": {
                    "type": "subscriptionAvailabilities",
                    "attributes": {"availableInNewTerritories": True},
                    "relationships": relationships,
                }
            },
        )
    else:
        api_request(
            token,
            "PATCH",
            f"/v1/subscriptionAvailabilities/{availability['id']}"
            "/relationships/availableTerritories",
            {"data": territory_links},
        )
    print(f"{subscription_id}: enabled in {len(territory_links)} storefronts")


def upload_asset(operation: dict, blob: bytes) -> None:
    offset = operation["offset"]
    chunk = blob[offset : offset + operation["length"]]
    command = [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--request",
        operation["method"],
        "--max-time",
        "180",
        "--header",
        "Expect:",
        "--data-binary",
        "@-",
    ]
    for header in operation.get("requestHeaders", []):
        command.extend(["--header", f"{header['name']}: {header['value']}"])
    command.append(operation["url"])
    subprocess.run(command, input=chunk, check=True)


def main() -> None:
    token = access_token()
    blob = SCREENSHOT.read_bytes()
    checksum = hashlib.md5(blob, usedforsecurity=False).hexdigest()

    for subscription_id, label in SUBSCRIPTIONS.items():
        ensure_subscription_availability(token, subscription_id)
        response = api_request(
            token, "GET", f"/v1/subscriptions/{subscription_id}/appStoreReviewScreenshot"
        )
        screenshot = response.get("data")
        if screenshot is None:
            response = api_request(
                token,
                "POST",
                "/v1/subscriptionAppStoreReviewScreenshots",
                {
                    "data": {
                        "type": "subscriptionAppStoreReviewScreenshots",
                        "attributes": {
                            "fileSize": len(blob),
                            "fileName": f"yield-{label}-subscription-review.png",
                        },
                        "relationships": {
                            "subscription": {
                                "data": {"type": "subscriptions", "id": subscription_id}
                            }
                        },
                    }
                },
            )
            screenshot = response["data"]

        attributes = screenshot.get("attributes", {})
        delivery_state = attributes.get("assetDeliveryState", {}).get("state")
        if delivery_state not in {"COMPLETE", "COMPLETED"}:
            operations = attributes.get("uploadOperations", [])
            for operation in operations:
                upload_asset(operation, blob)
            api_request(
                token,
                "PATCH",
                f"/v1/subscriptionAppStoreReviewScreenshots/{screenshot['id']}",
                {
                    "data": {
                        "type": "subscriptionAppStoreReviewScreenshots",
                        "id": screenshot["id"],
                        "attributes": {
                            "sourceFileChecksum": checksum,
                            "uploaded": True,
                        },
                    }
                },
            )
        print(f"{label}: review screenshot submitted")


if __name__ == "__main__":
    main()
