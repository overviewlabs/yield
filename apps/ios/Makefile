PROJECT := WHOXTreasury.xcodeproj
SCHEME := WHOXTreasury
CONFIGURATION ?= Debug
DERIVED_DATA ?= .build/DerivedData
DESTINATION ?= platform=iOS Simulator,name=iPhone 17 Pro,OS=latest

.PHONY: generate build test

generate:
	@command -v xcodegen >/dev/null || { echo "xcodegen is required (brew install xcodegen)"; exit 1; }
	xcodegen generate --spec project.yml

build: generate
	xcodebuild \
		-project "$(PROJECT)" \
		-scheme "$(SCHEME)" \
		-configuration "$(CONFIGURATION)" \
		-destination 'generic/platform=iOS Simulator' \
		-derivedDataPath "$(DERIVED_DATA)" \
		CODE_SIGNING_ALLOWED=NO \
		build

test: generate
	xcodebuild \
		-project "$(PROJECT)" \
		-scheme "$(SCHEME)" \
		-configuration "$(CONFIGURATION)" \
		-destination '$(DESTINATION)' \
		-derivedDataPath "$(DERIVED_DATA)" \
		CODE_SIGNING_ALLOWED=NO \
		test
