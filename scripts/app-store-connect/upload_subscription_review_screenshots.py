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
BUNDLE_ID = "ai.whox.yield"
BETA_GROUP_ID = "18c04eab-014a-43a2-ad12-7b8aaa07a5f5"
BUILD_NUMBER = "5"
DIAGNOSTIC_PATH = Path(".github/storekit-diagnostic.json")
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
        available = api_request(
            token,
            "GET",
            f"/v1/subscriptionAvailabilities/{availability['id']}"
            "/availableTerritories?limit=200",
        )["data"]
        if not available:
            raise RuntimeError(
                f"Subscription {subscription_id} has no enabled App Store territories"
            )
        print(f"{subscription_id}: available in {len(available)} storefronts")


def assign_testflight_build(token: str) -> None:
    apps = api_request(token, "GET", f"/v1/apps?filter[bundleId]={BUNDLE_ID}&limit=2")["data"]
    if len(apps) != 1:
        raise RuntimeError(f"Expected exactly one App Store app for {BUNDLE_ID}")
    app_id = apps[0]["id"]
    build = None
    for _ in range(30):
        builds = api_request(
            token,
            "GET",
            f"/v1/builds?filter[app]={app_id}&filter[version]={BUILD_NUMBER}"
            "&sort=-uploadedDate&limit=1",
        )["data"]
        if builds and builds[0].get("attributes", {}).get("processingState") == "VALID":
            build = builds[0]
            break
        time.sleep(20)
    if build is None:
        raise RuntimeError(f"TestFlight Build {BUILD_NUMBER} did not become valid in time")
    result = api_request(
        token,
        "POST",
        f"/v1/betaGroups/{BETA_GROUP_ID}/relationships/builds",
        {"data": [{"type": "builds", "id": build["id"]}]},
        allowed_errors={409},
    )
    if result.get("errorStatus") == 409:
        print(f"Build {BUILD_NUMBER}: already assigned to Yield Internal Testers")
    else:
        print(f"Build {BUILD_NUMBER}: assigned to Yield Internal Testers")


def subscription_diagnostic(token: str, subscription_id: str) -> dict:
    subscription = api_request(token, "GET", f"/v1/subscriptions/{subscription_id}")["data"]
    availability = api_request(
        token,
        "GET",
        f"/v1/subscriptions/{subscription_id}/subscriptionAvailability",
        allowed_errors={404},
    ).get("data")
    territories = []
    if availability is not None:
        territories = api_request(
            token,
            "GET",
            f"/v1/subscriptionAvailabilities/{availability['id']}"
            "/availableTerritories?limit=200",
        )["data"]
    return {
        "id": subscription_id,
        "attributes": subscription.get("attributes", {}),
        "availability": None if availability is None else availability.get("attributes", {}),
        "territoryCount": len(territories),
        "includesUSA": any(item["id"] == "USA" for item in territories),
        "priceCount": len(
            api_request(
                token, "GET", f"/v1/subscriptions/{subscription_id}/prices?limit=200"
            )["data"]
        ),
        "introductoryOfferCount": len(
            api_request(
                token,
                "GET",
                f"/v1/subscriptions/{subscription_id}/introductoryOffers?limit=200",
            )["data"]
        ),
        "localizationCount": len(
            api_request(
                token,
                "GET",
                f"/v1/subscriptions/{subscription_id}/subscriptionLocalizations?limit=200",
            )["data"]
        ),
    }


def submit_subscription(token: str, subscription_id: str) -> dict:
    response = api_request(
        token,
        "POST",
        "/v1/subscriptionSubmissions",
        {
            "data": {
                "type": "subscriptionSubmissions",
                "relationships": {
                    "subscription": {
                        "data": {"type": "subscriptions", "id": subscription_id}
                    }
                },
            }
        },
        allowed_errors={403, 409, 422},
    )
    if "data" in response:
        return {"submitted": True, "submissionId": response["data"]["id"]}
    detail = response.get("errorDetail", "")
    try:
        errors = json.loads(detail).get("errors", [])
        message = errors[0].get("detail", detail) if errors else detail
    except json.JSONDecodeError:
        message = detail
    return {
        "submitted": False,
        "status": response.get("errorStatus"),
        "message": message,
    }


def response_error(response: dict) -> dict:
    detail = response.get("errorDetail", "")
    try:
        errors = json.loads(detail).get("errors", [])
        message = errors[0].get("detail", detail) if errors else detail
    except json.JSONDecodeError:
        message = detail
    return {"status": response.get("errorStatus"), "message": message}


def ensure_subscription_version(token: str, subscription_id: str) -> dict:
    versions = api_request(
        token, "GET", f"/v1/subscriptions/{subscription_id}/versions?limit=10"
    )["data"]
    if versions:
        return versions[0]
    created = api_request(
        token,
        "POST",
        "/v1/subscriptionVersions",
        {
            "data": {
                "type": "subscriptionVersions",
                "relationships": {
                    "subscription": {
                        "data": {"type": "subscriptions", "id": subscription_id}
                    }
                },
            }
        },
    )["data"]
    localizations = api_request(
        token,
        "GET",
        f"/v1/subscriptions/{subscription_id}/subscriptionLocalizations?limit=200",
    )["data"]
    for localization in localizations:
        attributes = localization.get("attributes", {})
        api_request(
            token,
            "POST",
            "/v2/subscriptionLocalizations",
            {
                "data": {
                    "type": "subscriptionLocalizations",
                    "attributes": {
                        "locale": attributes["locale"],
                        "name": attributes["name"],
                        "description": attributes.get("description", ""),
                    },
                    "relationships": {
                        "version": {
                            "data": {"type": "subscriptionVersions", "id": created["id"]}
                        }
                    },
                }
            },
        )
    return created


def add_review_item(
    token: str, review_submission_id: str, relationship: str, resource_type: str, resource_id: str
) -> dict:
    response = api_request(
        token,
        "POST",
        "/v1/reviewSubmissionItems",
        {
            "data": {
                "type": "reviewSubmissionItems",
                "relationships": {
                    "reviewSubmission": {
                        "data": {
                            "type": "reviewSubmissions",
                            "id": review_submission_id,
                        }
                    },
                    relationship: {"data": {"type": resource_type, "id": resource_id}},
                },
            }
        },
        allowed_errors={409, 422},
    )
    return {"added": "data" in response, **({} if "data" in response else response_error(response))}


def complete_app_review_submission(token: str) -> dict:
    apps = api_request(token, "GET", f"/v1/apps?filter[bundleId]={BUNDLE_ID}&limit=2")["data"]
    if len(apps) != 1:
        return {"submitted": False, "message": f"Expected one app for {BUNDLE_ID}"}
    app_id = apps[0]["id"]
    app_versions = api_request(
        token,
        "GET",
        f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=IOS"
        "&filter[versionString]=1.0&limit=10",
    )["data"]
    if not app_versions:
        return {"submitted": False, "message": "No iOS App Store version 1.0 exists"}
    app_version = app_versions[0]
    localization_data = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/appStoreVersionLocalizations?limit=200",
    )["data"]
    localization_diagnostics = []
    for localization in localization_data:
        screenshot_sets = api_request(
            token,
            "GET",
            f"/v1/appStoreVersionLocalizations/{localization['id']}/appScreenshotSets?limit=200",
        )["data"]
        localization_diagnostics.append(
            {
                "id": localization["id"],
                "attributes": localization.get("attributes", {}),
                "screenshotSetCount": len(screenshot_sets),
            }
        )
    review_detail = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/appStoreReviewDetail",
        allowed_errors={404},
    ).get("data")
    age_rating = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/ageRatingDeclaration",
        allowed_errors={404},
    ).get("data")
    app_version_diagnostic = {
        "id": app_version["id"],
        "attributes": app_version.get("attributes", {}),
        "localizations": localization_diagnostics,
        "reviewDetail": None if review_detail is None else review_detail.get("attributes", {}),
        "ageRating": None if age_rating is None else age_rating.get("attributes", {}),
    }
    subscription_versions = [
        ensure_subscription_version(token, subscription_id) for subscription_id in SUBSCRIPTIONS
    ]
    existing = api_request(
        token, "GET", f"/v1/reviewSubmissions?filter[app]={app_id}&limit=50"
    )["data"]
    pending = next(
        (item for item in existing if not item.get("attributes", {}).get("submitted", False)),
        None,
    )
    if pending is None:
        created = api_request(
            token,
            "POST",
            "/v1/reviewSubmissions",
            {
                "data": {
                    "type": "reviewSubmissions",
                    "attributes": {"platform": "IOS"},
                    "relationships": {
                        "app": {"data": {"type": "apps", "id": app_id}}
                    },
                }
            },
            allowed_errors={409, 422},
        )
        if "data" not in created:
            return {
                "submitted": False,
                "stage": "create",
                "appStoreVersion": app_version_diagnostic,
                **response_error(created),
            }
        pending = created["data"]
    submission_id = pending["id"]
    items = [
        {
            "kind": "appStoreVersion",
            **add_review_item(
                token,
                submission_id,
                "appStoreVersion",
                "appStoreVersions",
                app_version["id"],
            ),
        }
    ]
    for version in subscription_versions:
        items.append(
            {
                "kind": "subscriptionVersion",
                "id": version["id"],
                **add_review_item(
                    token,
                    submission_id,
                    "subscriptionVersion",
                    "subscriptionVersions",
                    version["id"],
                ),
            }
        )
    submitted = api_request(
        token,
        "PATCH",
        f"/v1/reviewSubmissions/{submission_id}",
        {
            "data": {
                "type": "reviewSubmissions",
                "id": submission_id,
                "attributes": {"submitted": True},
            }
        },
        allowed_errors={409, 422},
    )
    return {
        "submitted": "data" in submitted,
        "submissionId": submission_id,
        "items": items,
        "appStoreVersion": app_version_diagnostic,
        **({} if "data" in submitted else response_error(submitted)),
    }


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
    submissions = []

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
        submissions.append(
            {"subscriptionId": subscription_id, **submit_subscription(token, subscription_id)}
        )

    assign_testflight_build(token)
    review_submission = complete_app_review_submission(token)
    time.sleep(5)
    diagnostics = [subscription_diagnostic(token, item) for item in SUBSCRIPTIONS]
    DIAGNOSTIC_PATH.write_text(
        json.dumps(
            {
                "subscriptions": diagnostics,
                "submissionAttempts": submissions,
                "reviewSubmission": review_submission,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
