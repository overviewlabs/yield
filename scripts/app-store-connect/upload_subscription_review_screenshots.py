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
PRIVACY_URL = "https://github.com/overviewlabs/yield/blob/main/PRIVACY.md"
SUPPORT_URL = "https://github.com/overviewlabs/yield/blob/main/SUPPORT.md"
MARKETING_URL = "https://github.com/overviewlabs/yield"
APP_SCREENSHOTS = [
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/iphone-clean-assets-final/C0B9E2F8-7CA2-4D67-83EA-FAD97176763B.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/iphone-clean-assets-final/07B051C9-2D79-4EFE-A6C1-E2CCFF6B13E8.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/iphone-clean-assets-final/A8CC422C-880E-4785-9559-8B9B2363A7DC.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/iphone-clean-assets-final/778EDA6B-0AC3-41F9-86B6-DE8C0CDCB4C9.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/iphone-clean-assets-final/FAF0660E-8F5C-4D45-9631-92C0D696C36A.png"),
]
IPAD_SCREENSHOTS = [
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/ipad-final-green/4ACFB550-FF5B-40D9-9E24-C9B70258FA0B.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/ipad-final-green/800D685E-AC31-4F32-8C22-AD584891D344.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/ipad-final-green/E7EEA644-1AC0-44AB-9D0B-504B905765FE.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/ipad-final-green/00EFE791-DF7C-445D-A333-A136ED35674B.png"),
    Path("apps/ios/Documentation/QA/2026-08-01/visual-review/ipad-final-green/3F156749-FE4C-468A-BD05-2B8D7CF6D966.png"),
]
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


def ensure_free_app_price(token: str, app_id: str) -> dict:
    """Ensure the downloadable app itself is free in the USA base storefront."""
    schedule = api_request(
        token,
        "GET",
        f"/v1/apps/{app_id}/appPriceSchedule",
        allowed_errors={404},
    ).get("data")
    if schedule is not None:
        base_territory = api_request(
            token,
            "GET",
            f"/v1/appPriceSchedules/{schedule['id']}/baseTerritory",
            allowed_errors={404},
        ).get("data")
        manual_prices = api_request(
            token,
            "GET",
            f"/v1/appPriceSchedules/{schedule['id']}/manualPrices"
            "?filter[territory]=USA&include=appPricePoint"
            "&fields[appPricePoints]=customerPrice&limit=200",
            allowed_errors={404},
        )
        included = manual_prices.get("included", [])
        price_points = {
            item["id"]: item.get("attributes", {}).get("customerPrice")
            for item in included
            if item.get("type") == "appPricePoints"
        }
        current_prices = []
        for price in manual_prices.get("data", []):
            if price.get("attributes", {}).get("endDate") is not None:
                continue
            point = (
                price.get("relationships", {})
                .get("appPricePoint", {})
                .get("data", {})
                .get("id")
            )
            current_prices.append(price_points.get(point))
        if base_territory is not None and "0.0" in current_prices:
            return {
                "configured": True,
                "baseTerritory": base_territory["id"],
                "customerPrice": "0.0",
            }

    price_points = api_request(
        token,
        "GET",
        f"/v1/apps/{app_id}/appPricePoints?filter[territory]=USA"
        "&fields[appPricePoints]=customerPrice&limit=200",
    )["data"]
    free_point = next(
        (
            item
            for item in price_points
            if item.get("attributes", {}).get("customerPrice") in {"0", "0.0", "0.00"}
        ),
        None,
    )
    if free_point is None:
        raise RuntimeError("Apple returned no free app price point for the USA storefront")

    inline_id = "${yield-free-price}"
    response = api_request(
        token,
        "POST",
        "/v1/appPriceSchedules",
        {
            "data": {
                "type": "appPriceSchedules",
                "relationships": {
                    "app": {"data": {"type": "apps", "id": app_id}},
                    "baseTerritory": {
                        "data": {"type": "territories", "id": "USA"}
                    },
                    "manualPrices": {
                        "data": [{"type": "appPrices", "id": inline_id}]
                    },
                },
            },
            "included": [
                {
                    "type": "appPrices",
                    "id": inline_id,
                    "attributes": {"startDate": None},
                    "relationships": {
                        "appPricePoint": {
                            "data": {
                                "type": "appPricePoints",
                                "id": free_point["id"],
                            }
                        }
                    },
                }
            ],
        },
    )
    return {
        "configured": "data" in response,
        "baseTerritory": "USA",
        "customerPrice": "0.0",
    }


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
    app_price = ensure_free_app_price(token, app_id)
    localization_data = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/appStoreVersionLocalizations?limit=200",
    )["data"]
    complete_app_store_metadata(token, app_id, app_version, localization_data)
    app_version = api_request(
        token, "GET", f"/v1/appStoreVersions/{app_version['id']}"
    )["data"]
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
                "screenshotSets": [
                    {
                        "id": item["id"],
                        "attributes": item.get("attributes", {}),
                        "screenshots": [
                            screenshot.get("attributes", {})
                            for screenshot in api_request(
                                token,
                                "GET",
                                f"/v1/appScreenshotSets/{item['id']}/appScreenshots?limit=200",
                            )["data"]
                        ],
                    }
                    for item in screenshot_sets
                ],
            }
        )
    review_detail = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/appStoreReviewDetail",
        allowed_errors={404},
    ).get("data")
    app_infos = api_request(token, "GET", f"/v1/apps/{app_id}/appInfos?limit=10")["data"]
    app_info_diagnostics = []
    for app_info in app_infos:
        age_rating = api_request(
            token, "GET", f"/v1/appInfos/{app_info['id']}/ageRatingDeclaration"
        ).get("data")
        app_info_diagnostics.append(
            {
                "id": app_info["id"],
                "attributes": app_info.get("attributes", {}),
                "ageRating": None
                if age_rating is None
                else age_rating.get("attributes", {}),
            }
        )
    build = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/build",
        allowed_errors={404},
    ).get("data")
    availability = api_request(
        token,
        "GET",
        f"/v1/apps/{app_id}/appAvailabilityV2",
        allowed_errors={404},
    ).get("data")
    price_schedule = api_request(
        token,
        "GET",
        f"/v1/apps/{app_id}/appPriceSchedule",
        allowed_errors={404},
    ).get("data")
    app_version_diagnostic = {
        "id": app_version["id"],
        "attributes": app_version.get("attributes", {}),
        "localizations": localization_diagnostics,
        "reviewDetail": None if review_detail is None else review_detail.get("attributes", {}),
        "appInfos": app_info_diagnostics,
        "build": None if build is None else build.get("attributes", {}),
        "availability": None if availability is None else availability.get("attributes", {}),
        "priceSchedule": {
            **({} if price_schedule is None else price_schedule.get("attributes", {})),
            **app_price,
        },
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


def upload_app_screenshots(token: str, localization_id: str) -> None:
    sets = api_request(
        token,
        "GET",
        f"/v1/appStoreVersionLocalizations/{localization_id}/appScreenshotSets?limit=200",
    )["data"]
    for display_type, paths in (
        ("APP_IPHONE_61", APP_SCREENSHOTS),
        ("APP_IPAD_PRO_3GEN_129", IPAD_SCREENSHOTS),
    ):
        screenshot_set = next(
            (
                item
                for item in sets
                if item.get("attributes", {}).get("screenshotDisplayType") == display_type
            ),
            None,
        )
        if screenshot_set is None:
            screenshot_set = api_request(
                token,
                "POST",
                "/v1/appScreenshotSets",
                {
                    "data": {
                        "type": "appScreenshotSets",
                        "attributes": {"screenshotDisplayType": display_type},
                        "relationships": {
                            "appStoreVersionLocalization": {
                                "data": {
                                    "type": "appStoreVersionLocalizations",
                                    "id": localization_id,
                                }
                            }
                        },
                    }
                },
            )["data"]
        existing = api_request(
            token,
            "GET",
            f"/v1/appScreenshotSets/{screenshot_set['id']}/appScreenshots?limit=200",
        )["data"]
        if existing:
            continue
        for position, path in enumerate(paths, start=1):
            blob = path.read_bytes()
            screenshot = api_request(
                token,
                "POST",
                "/v1/appScreenshots",
                {
                    "data": {
                        "type": "appScreenshots",
                        "attributes": {
                            "fileSize": len(blob),
                            "fileName": f"yield-{display_type}-{position}-{path.name}",
                        },
                        "relationships": {
                            "appScreenshotSet": {
                                "data": {
                                    "type": "appScreenshotSets",
                                    "id": screenshot_set["id"],
                                }
                            }
                        },
                    }
                },
            )["data"]
            for operation in screenshot.get("attributes", {}).get("uploadOperations", []):
                upload_asset(operation, blob)
            api_request(
                token,
                "PATCH",
                f"/v1/appScreenshots/{screenshot['id']}",
                {
                    "data": {
                        "type": "appScreenshots",
                        "id": screenshot["id"],
                        "attributes": {
                            "sourceFileChecksum": hashlib.md5(
                                blob, usedforsecurity=False
                            ).hexdigest(),
                            "uploaded": True,
                        },
                    }
                },
            )


def complete_app_store_metadata(
    token: str, app_id: str, app_version: dict, localizations: list[dict]
) -> None:
    availability = api_request(
        token,
        "GET",
        f"/v1/apps/{app_id}/appAvailabilityV2",
        allowed_errors={404},
    ).get("data")
    if availability is None:
        territories = api_request(token, "GET", "/v1/territories?limit=200")["data"]
        included = []
        links = []
        for territory in territories:
            local_id = "${" + territory["id"] + "}"
            links.append({"type": "territoryAvailabilities", "id": local_id})
            included.append(
                {
                    "type": "territoryAvailabilities",
                    "id": local_id,
                    "attributes": {"available": True, "preOrderEnabled": False},
                    "relationships": {
                        "territory": {
                            "data": {"type": "territories", "id": territory["id"]}
                        }
                    },
                }
            )
        api_request(
            token,
            "POST",
            "/v2/appAvailabilities",
            {
                "data": {
                    "type": "appAvailabilities",
                    "attributes": {"availableInNewTerritories": True},
                    "relationships": {
                        "app": {"data": {"type": "apps", "id": app_id}},
                        "territoryAvailabilities": {"data": links},
                    },
                },
                "included": included,
            },
        )
    api_request(
        token,
        "PATCH",
        f"/v1/apps/{app_id}",
        {
            "data": {
                "type": "apps",
                "id": app_id,
                "attributes": {"contentRightsDeclaration": "USES_THIRD_PARTY_CONTENT"},
            }
        },
    )
    api_request(
        token,
        "PATCH",
        f"/v1/appStoreVersions/{app_version['id']}",
        {
            "data": {
                "type": "appStoreVersions",
                "id": app_version["id"],
                "attributes": {"copyright": "2026 Evans Obeng", "usesIdfa": False},
            }
        },
    )
    description = (
        "Yield helps users monitor portfolios, select versioned investment strategies, "
        "set explicit risk limits, review proposed activity, and control future automation. "
        "Brokerage authorization and permissions remain separate. Investing and options "
        "involve risk, including possible loss of principal, and automated analysis can be wrong."
    )
    for localization in localizations:
        api_request(
            token,
            "PATCH",
            f"/v1/appStoreVersionLocalizations/{localization['id']}",
            {
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "id": localization["id"],
                    "attributes": {
                        "description": description,
                        "keywords": "portfolio,investing,stocks,options,automation,risk,analysis",
                        "marketingUrl": MARKETING_URL,
                        "promotionalText": "Portfolio monitoring and automated strategy controls with explicit risk limits.",
                        "supportUrl": SUPPORT_URL,
                    },
                }
            },
        )
        upload_app_screenshots(token, localization["id"])
    app_infos = api_request(token, "GET", f"/v1/apps/{app_id}/appInfos?limit=10")["data"]
    for app_info in app_infos:
        api_request(
            token,
            "PATCH",
            f"/v1/appInfos/{app_info['id']}",
            {
                "data": {
                    "type": "appInfos",
                    "id": app_info["id"],
                    "relationships": {
                        "primaryCategory": {
                            "data": {"type": "appCategories", "id": "FINANCE"}
                        }
                    },
                }
            },
        )
        rating = api_request(
            token,
            "GET",
            f"/v1/appInfos/{app_info['id']}/ageRatingDeclaration",
        )["data"]
        api_request(
            token,
            "PATCH",
            f"/v1/ageRatingDeclarations/{rating['id']}",
            {
                "data": {
                    "type": "ageRatingDeclarations",
                    "id": rating["id"],
                    "attributes": {
                        "advertising": False,
                        "alcoholTobaccoOrDrugUseOrReferences": "NONE",
                        "contests": "NONE",
                        "gambling": False,
                        "gamblingSimulated": "NONE",
                        "gunsOrOtherWeapons": "NONE",
                        "healthOrWellnessTopics": False,
                        "lootBox": False,
                        "medicalOrTreatmentInformation": "NONE",
                        "messagingAndChat": False,
                        "parentalControls": False,
                        "profanityOrCrudeHumor": "NONE",
                        "ageAssurance": False,
                        "sexualContentGraphicAndNudity": "NONE",
                        "sexualContentOrNudity": "NONE",
                        "socialMedia": False,
                        "socialMediaAgeRestricted": False,
                        "horrorOrFearThemes": "NONE",
                        "matureOrSuggestiveThemes": "NONE",
                        "unrestrictedWebAccess": False,
                        "userGeneratedContent": False,
                        "violenceCartoonOrFantasy": "NONE",
                        "violenceRealisticProlongedGraphicOrSadistic": "NONE",
                        "violenceRealistic": "NONE",
                    },
                }
            },
        )
        info_localizations = api_request(
            token,
            "GET",
            f"/v1/appInfos/{app_info['id']}/appInfoLocalizations?limit=200",
        )["data"]
        for localization in info_localizations:
            if localization.get("attributes", {}).get("locale") != "en-US":
                continue
            api_request(
                token,
                "PATCH",
                f"/v1/appInfoLocalizations/{localization['id']}",
                {
                    "data": {
                        "type": "appInfoLocalizations",
                        "id": localization["id"],
                        "attributes": {"privacyPolicyUrl": PRIVACY_URL},
                    }
                },
            )
    builds = api_request(
        token,
        "GET",
        f"/v1/builds?filter[app]={app_id}&filter[version]={BUILD_NUMBER}"
        "&sort=-uploadedDate&limit=1",
    )["data"]
    if builds:
        api_request(
            token,
            "PATCH",
            f"/v1/appStoreVersions/{app_version['id']}/relationships/build",
            {"data": {"type": "builds", "id": builds[0]["id"]}},
        )
    review = api_request(
        token,
        "GET",
        f"/v1/appStoreVersions/{app_version['id']}/appStoreReviewDetail",
        allowed_errors={404},
    ).get("data")
    review_attributes = {
        "contactFirstName": "Evans",
        "contactLastName": "Obeng",
        "contactPhone": "+15707658048",
        "contactEmail": "admin@overviewlabs.ai",
        "demoAccountRequired": False,
        "notes": (
            "Sign in with Apple is supported. Investment and subscription access do not "
            "override risk restrictions or brokerage permissions. Yield is not Robinhood."
        ),
    }
    if review is None:
        api_request(
            token,
            "POST",
            "/v1/appStoreReviewDetails",
            {
                "data": {
                    "type": "appStoreReviewDetails",
                    "attributes": review_attributes,
                    "relationships": {
                        "appStoreVersion": {
                            "data": {"type": "appStoreVersions", "id": app_version["id"]}
                        }
                    },
                }
            },
        )
    else:
        api_request(
            token,
            "PATCH",
            f"/v1/appStoreReviewDetails/{review['id']}",
            {
                "data": {
                    "type": "appStoreReviewDetails",
                    "id": review["id"],
                    "attributes": review_attributes,
                }
            },
        )


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
