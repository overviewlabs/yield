import XCTest

@MainActor
final class WHoxTreasuryUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() async throws {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-skipOnboarding", "-mockBiometricSuccess", "-uiPrivacyModeOff"]
  }

  func testFiveTabDemoDashboard() {
    app.launch()
    XCTAssertTrue(app.navigationBars["Treasury"].waitForExistence(timeout: 5))
    for label in ["Home", "Portfolio", "Agents", "Activity", "Settings"] {
      XCTAssertTrue(
        app.buttons[label].exists || app.tabBars.buttons[label].exists, "Missing tab \(label)")
    }
    XCTAssertTrue(app.otherElements["accountSummary"].exists)
  }

  func testAppReviewDemoEntry() {
    app.launchArguments = ["-resetOnboarding", "-mockBiometricSuccess", "-uiPrivacyModeOff"]
    app.launch()
    let demo = app.buttons["Open App Review Demo"]
    XCTAssertTrue(demo.waitForExistence(timeout: 5))
    demo.tap()
    XCTAssertTrue(app.navigationBars["Treasury"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.otherElements["accountSummary"].waitForExistence(timeout: 5))
  }

  func testProposalRequiresDetailReview() {
    app.launch()
    tapTab("Activity")
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    let proposal = app.staticTexts["Awaiting User Approval"]
    XCTAssertTrue(proposal.waitForExistence(timeout: 5))
    proposal.tap()
    XCTAssertTrue(app.buttons["Approve and Submit"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Deterministic risk checks"].exists)
  }

  func testOptionsPositionDetail() {
    app.launch()
    tapTab("Portfolio")
    XCTAssertTrue(app.navigationBars["Portfolio"].waitForExistence(timeout: 5))
    app.staticTexts["AAPL"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Options position"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Review Close"].exists)
  }

  func testOfflineStateIsActionable() {
    app.launchArguments.append("-uiOffline")
    app.launch()
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'offline'")).firstMatch
        .waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Retry"].exists)
  }

  func testLargeDynamicTypeAndDarkModeLaunch() {
    app.launchArguments.append("-uiDarkMode")
    app.launchEnvironment["UIPreferredContentSizeCategoryName"] =
      "UICTContentSizeCategoryAccessibilityXXXL"
    app.launch()
    XCTAssertTrue(app.navigationBars["Treasury"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Portfolio"].exists || app.tabBars.buttons["Portfolio"].exists)
  }

  func testPauseAllRequiresExplicitConfirmation() {
    app.launch()
    openSettings()
    let pause = app.buttons["Pause all agents"]
    scrollUntilHittable(pause)
    XCTAssertTrue(pause.isHittable)
    pause.tap()
    XCTAssertTrue(app.navigationBars["Pause All Review"].waitForExistence(timeout: 5))

    let confirm = app.buttons["Confirm Pause All"]
    scrollUntilExists(confirm)
    XCTAssertTrue(confirm.exists)
    XCTAssertFalse(confirm.isEnabled)
    let acknowledgement = app.switches["pauseAllAcknowledgement"]
    scrollUntilHittable(acknowledgement)
    XCTAssertTrue(acknowledgement.isHittable)
    acknowledgement.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    XCTAssertTrue(waitFor(NSPredicate(format: "value == '1'"), on: acknowledgement))
    XCTAssertTrue(waitFor(NSPredicate(format: "enabled == true"), on: confirm))
    confirm.tap()
    tapTab("Activity")
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    let pauseEvent = app.descendants(matching: .any).matching(
      NSPredicate(format: "label CONTAINS[c] 'All agent scheduling'")
    )
    .firstMatch
    XCTAssertTrue(pauseEvent.waitForExistence(timeout: 5))
  }

  func testAvailableAgentCanBeActivatedInObserveMode() {
    app.launchArguments.append("-uiNoActiveAgents")
    app.launch()
    tapTab("Agents")
    XCTAssertTrue(app.navigationBars["Agents"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["No active agents"].waitForExistence(timeout: 5))
    let activeCount = app.staticTexts["activeAgentCount"]
    XCTAssertTrue(activeCount.waitForExistence(timeout: 5))
    XCTAssertEqual(activeCount.label, "0")

    let activate = app.buttons["agentToggle.foundation-equity"]
    XCTAssertTrue(activate.waitForExistence(timeout: 5))
    activate.tap()
    XCTAssertTrue(waitFor(NSPredicate(format: "label == '1'"), on: activeCount))
    XCTAssertTrue(app.staticTexts["Foundation Equity"].firstMatch.exists)
  }

  func testRestorePurchasesReportsCompletion() {
    app.launchArguments.append("-mockStoreKitRestoreSuccess")
    app.launch()
    openSettings()
    let currentPlan = app.staticTexts["Current plan"]
    XCTAssertTrue(currentPlan.waitForExistence(timeout: 5))
    currentPlan.tap()
    XCTAssertTrue(app.navigationBars["Subscription"].waitForExistence(timeout: 5))

    let restore = app.buttons["Restore Purchases"]
    scrollUntilHittable(restore)
    XCTAssertTrue(restore.isHittable)
    restore.tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["restorePurchasesStatus"].waitForExistence(timeout: 5))
  }

  func testAccountDeletionRequiresExactTypedConfirmation() {
    app.launch()
    openSettings()
    let deleteAccount = app.buttons["Delete account"]
    XCTAssertTrue(deleteAccount.waitForExistence(timeout: 5))
    deleteAccount.tap()
    XCTAssertTrue(app.navigationBars["Delete Account"].waitForExistence(timeout: 5))

    let destructive = app.buttons["Authenticate and Request Account Deletion"]
    XCTAssertTrue(destructive.waitForExistence(timeout: 5))
    XCTAssertFalse(destructive.isEnabled)
    let field = app.textFields["DELETE"]
    field.tap()
    field.typeText("DELETE")
    XCTAssertTrue(destructive.isEnabled)
  }

  func testRobinhoodConnectOpensSecureHandoffAndUsesVerifiedConnection() {
    app.launch()
    openSettings()
    let connection = app.staticTexts["Agentic Account"]
    scrollUntilHittable(connection)
    connection.tap()
    XCTAssertTrue(app.navigationBars["Robinhood Connection"].waitForExistence(timeout: 5))

    let connect = app.buttons["Reconnect Robinhood"]
    scrollUntilHittable(connect)
    connect.tap()

    XCTAssertTrue(app.navigationBars["Broker Connection"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Secure Robinhood handoff"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Use Connection"].waitForExistence(timeout: 8))
  }

  func testReduceMotionPreferenceIsReflectedInAppearanceControls() {
    app.launchArguments.append("-uiReduceMotion")
    app.launch()
    openSettings()
    let displayAndPrivacy = app.staticTexts["Display and privacy"]
    scrollUntilHittable(displayAndPrivacy)
    XCTAssertTrue(displayAndPrivacy.isHittable)
    displayAndPrivacy.tap()
    XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 5))

    let reduceChartAnimation = app.switches["Reduce chart animation"]
    XCTAssertTrue(reduceChartAnimation.waitForExistence(timeout: 5))
    XCTAssertEqual(reduceChartAnimation.value as? String, "1")
  }

  func testBiometricFailureLeavesProposalAwaitingApproval() {
    app.launchArguments = ["-skipOnboarding", "-mockBiometricFailure", "-uiPrivacyModeOff"]
    app.launch()
    tapTab("Activity")
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    let proposal = app.staticTexts["Awaiting User Approval"]
    XCTAssertTrue(proposal.waitForExistence(timeout: 5))
    proposal.tap()
    let approve = app.buttons["Approve and Submit"]
    XCTAssertTrue(approve.waitForExistence(timeout: 5))
    approve.tap()

    let failureMessage = app.staticTexts[
      "Authentication was not completed. No sensitive action was taken."
    ]
    XCTAssertTrue(failureMessage.waitForExistence(timeout: 10))
    let alert = app.alerts["Metis"]
    XCTAssertTrue(alert.exists)
    alert.buttons["OK"].tap()
    XCTAssertTrue(approve.waitForExistence(timeout: 5))
  }

  func testAllFourteenOnboardingStepsHaveReachableActions() {
    app.launchArguments = [
      "-resetOnboarding", "-mockBiometricSuccess", "-uiValidOnboardingAnswers", "-uiLightMode",
      "-uiPrivacyModeOff",
    ]
    app.launch()

    assertText("Automated strategies. Your limits.")
    attachScreenshot("01-welcome")
    app.buttons["Get Started"].tap()

    assertText("Sign in securely")
    attachScreenshot("02-sign-in")
    app.buttons["Use App Review Demo Identity"].tap()

    advanceStandardStep(title: "Confirm eligibility", screenshot: "03-eligibility")
    advanceStandardStep(title: "How it works", screenshot: "04-how-it-works")
    advanceStandardStep(title: "Investor profile", screenshot: "05-investor-profile")
    advanceStandardStep(title: "Choose a plan", screenshot: "06-subscription")
    advanceStandardStep(title: "Choose your first agent", screenshot: "07-agent")
    advanceStandardStep(title: "Set hard risk limits", screenshot: "08-risk-limits")
    advanceStandardStep(title: "Choose an approval mode", screenshot: "09-automation")

    assertText("Connect Robinhood")
    XCTAssertTrue(app.staticTexts["Robinhood-controlled setup"].exists)
    attachScreenshot("10-connection-empty")
    let generate = app.buttons["Connect to Robinhood"]
    scrollUntilHittable(generate)
    generate.tap()
    let completeDemo = app.buttons["Complete Demo Pairing"]
    if completeDemo.waitForExistence(timeout: 2) {
      let pairingCode = app.staticTexts["pairingCode"]
      scrollUntilHittable(pairingCode)
      XCTAssertTrue(pairingCode.isHittable)
      XCTAssertTrue(app.staticTexts["Authorization link"].exists)
      XCTAssertTrue(app.buttons["Copy Robinhood Link"].exists)
      XCTAssertTrue(app.buttons["Share Robinhood Link"].exists)
      scrollUpUntilHittable(completeDemo)
      XCTAssertTrue(completeDemo.isHittable)
      completeDemo.tap()
    }
    let connectionContinue = app.buttons["Continue"]
    XCTAssertTrue(connectionContinue.waitForExistence(timeout: 8))
    XCTAssertFalse(app.staticTexts["Authorization link"].exists)
    XCTAssertFalse(app.staticTexts["pairingCode"].exists)
    XCTAssertFalse(app.buttons["Copy Robinhood Link"].exists)
    XCTAssertFalse(app.buttons["Share Robinhood Link"].exists)
    attachScreenshot("10-connection-pairing")
    connectionContinue.tap()

    assertText("Stay informed")
    attachScreenshot("11-notifications")
    app.buttons["Not Now"].tap()

    assertText("Protect sensitive actions")
    attachScreenshot("12-device-security")
    let later = app.buttons["Set Up Later"]
    scrollUntilHittable(later)
    later.tap()

    assertText("Review your Treasury")
    let accept = app.buttons["Accept All Demo Document Fixtures"]
    scrollUntilHittable(accept)
    XCTAssertTrue(accept.isHittable)
    accept.tap()
    attachScreenshot("13-final-review")
    let finish = app.buttons["Accept and Finish Setup"]
    XCTAssertTrue(finish.waitForExistence(timeout: 5))
    finish.tap()

    assertText("Your Demo Treasury is ready")
    attachScreenshot("14-completion")
    let open = app.buttons["Open Treasury"]
    XCTAssertTrue(open.isHittable)
    open.tap()
    XCTAssertTrue(app.navigationBars["Treasury"].waitForExistence(timeout: 5))
  }

  func testFiveTabsDetailsAndSettingsAtAccessibilityXXXLInDarkMode() {
    app.launchArguments.append("-uiDarkMode")
    app.launchEnvironment["UIPreferredContentSizeCategoryName"] =
      "UICTContentSizeCategoryAccessibilityXXXL"
    app.launch()

    XCTAssertTrue(app.navigationBars["Treasury"].waitForExistence(timeout: 5))
    attachScreenshot("xxxl-dark-home")

    tapTab("Portfolio")
    XCTAssertTrue(app.navigationBars["Portfolio"].waitForExistence(timeout: 5))
    attachScreenshot("xxxl-dark-portfolio")
    let position = app.staticTexts["AAPL"].firstMatch
    scrollUntilHittable(position)
    position.tap()
    XCTAssertTrue(app.staticTexts["Options position"].waitForExistence(timeout: 5))
    attachScreenshot("xxxl-dark-position-detail")
    app.navigationBars.buttons.firstMatch.tap()

    tapTab("Agents")
    XCTAssertTrue(app.navigationBars["Agents"].waitForExistence(timeout: 5))
    attachScreenshot("xxxl-dark-agents")

    tapTab("Activity")
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    attachScreenshot("xxxl-dark-activity")
    let proposal = app.staticTexts["Awaiting User Approval"]
    scrollUntilHittable(proposal)
    proposal.tap()
    XCTAssertTrue(app.buttons["Approve and Submit"].waitForExistence(timeout: 5))
    attachScreenshot("xxxl-dark-proposal-detail")
    app.navigationBars.buttons.firstMatch.tap()

    openSettings()
    attachScreenshot("xxxl-dark-settings")
    let connection = app.staticTexts["Agentic Account"]
    scrollUntilHittable(connection)
    connection.tap()
    XCTAssertTrue(app.navigationBars["Robinhood Connection"].waitForExistence(timeout: 5))
    let browserDisclosure = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS[c] 'secure authentication browser'")
    ).firstMatch
    scrollUntilExists(browserDisclosure)
    XCTAssertTrue(browserDisclosure.exists)
    attachScreenshot("xxxl-dark-connection-settings")
  }

  func testFiveTabsDetailsAndSettingsInLightMode() {
    app.launchArguments.append("-uiLightMode")
    app.launch()

    XCTAssertTrue(app.navigationBars["Treasury"].waitForExistence(timeout: 5))
    attachScreenshot("light-home")

    tapTab("Portfolio")
    XCTAssertTrue(app.navigationBars["Portfolio"].waitForExistence(timeout: 5))
    attachScreenshot("light-portfolio")
    let position = app.staticTexts["AAPL"].firstMatch
    scrollUntilHittable(position)
    position.tap()
    XCTAssertTrue(app.staticTexts["Options position"].waitForExistence(timeout: 5))
    attachScreenshot("light-position-detail")
    app.navigationBars.buttons.firstMatch.tap()

    tapTab("Agents")
    XCTAssertTrue(app.navigationBars["Agents"].waitForExistence(timeout: 5))
    attachScreenshot("light-agents")

    tapTab("Activity")
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    attachScreenshot("light-activity")
    let proposal = app.staticTexts["Awaiting User Approval"]
    scrollUntilHittable(proposal)
    proposal.tap()
    XCTAssertTrue(app.buttons["Approve and Submit"].waitForExistence(timeout: 5))
    attachScreenshot("light-proposal-detail")
    app.navigationBars.buttons.firstMatch.tap()

    openSettings()
    attachScreenshot("light-settings")
    let connection = app.staticTexts["Agentic Account"]
    scrollUntilHittable(connection)
    connection.tap()
    XCTAssertTrue(app.navigationBars["Robinhood Connection"].waitForExistence(timeout: 5))
    attachScreenshot("light-connection-settings")
  }

  private func tapTab(_ label: String) {
    // Content can contain buttons such as "View All" whose combined accessibility label
    // includes a tab name. A sheet dismissal can also briefly hide the tab bar, so wait for
    // the concrete tab-bar element before using the iPad-only global fallback.
    let tabBar = app.tabBars.firstMatch
    if tabBar.waitForExistence(timeout: 5) {
      let tab = tabBar.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
      XCTAssertTrue(tab.waitForExistence(timeout: 2), "Missing tab \(label)")
      tab.tap()
      return
    }
    let fallback = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    XCTAssertTrue(fallback.waitForExistence(timeout: 5), "Missing tab fallback \(label)")
    fallback.tap()
  }

  private func openSettings() {
    tapTab("Settings")
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
  }

  private func scrollUntilHittable(_ element: XCUIElement, attempts: Int = 8) {
    for _ in 0..<attempts where !element.isHittable {
      app.swipeUp()
    }
  }

  private func scrollUntilExists(_ element: XCUIElement, attempts: Int = 8) {
    for _ in 0..<attempts where !element.exists {
      app.swipeUp()
    }
  }

  private func scrollUpUntilHittable(_ element: XCUIElement, attempts: Int = 8) {
    for _ in 0..<attempts where !element.isHittable {
      app.swipeDown()
    }
  }

  private func waitFor(_ predicate: NSPredicate, on element: XCUIElement, timeout: TimeInterval = 5)
    -> Bool
  {
    XCTWaiter().wait(
      for: [XCTNSPredicateExpectation(predicate: predicate, object: element)],
      timeout: timeout
    ) == .completed
  }

  private func assertText(_ label: String, timeout: TimeInterval = 5) {
    let text = app.staticTexts[label]
    XCTAssertTrue(text.waitForExistence(timeout: timeout), "Missing text: \(label)")
  }

  private func advanceStandardStep(title: String, screenshot: String) {
    assertText(title)
    attachScreenshot(screenshot)
    let button = app.buttons["onboardingContinueButton"]
    XCTAssertTrue(button.waitForExistence(timeout: 5), "Missing Continue on \(title)")
    XCTAssertTrue(button.isEnabled, "Continue disabled on prefilled \(title)")
    button.tap()
  }

  private func attachScreenshot(_ name: String) {
    // Capture the settled frame after SwiftUI navigation/step transitions finish.
    Thread.sleep(forTimeInterval: 0.7)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
