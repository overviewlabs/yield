import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

enum TreasurySemanticColor {
  static func change(_ value: Double) -> Color {
    if value > 0 { return .green }
    if value < 0 { return .red }
    return .secondary
  }

  static func risk(_ state: RiskState) -> Color {
    switch state {
    case .normal: .green
    case .warning: .orange
    case .halted: .red
    }
  }
}

struct TreasuryCardModifier: ViewModifier {
  func body(content: Content) -> some View {
    content
      .padding(16)
      .background(
        Color(uiColor: .secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }
}

extension View {
  func treasuryCard() -> some View { modifier(TreasuryCardModifier()) }

  func treasuryTouchTarget() -> some View {
    frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
  }
}

struct BrandArtworkView: View {
  var size: CGFloat = 92

  var body: some View {
    Image("BrandArtwork")
      .resizable()
      .scaledToFit()
      .frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
      .accessibilityLabel("Metis vault compass")
  }
}

struct ModeBadge: View {
  let mode: TreasuryMode

  var body: some View {
    Label(
      mode.title,
      systemImage: mode == .demo ? "sparkles.rectangle.stack" : mode == .paper ? "doc.text" : "link"
    )
    .font(.caption.weight(.semibold))
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(.tint.opacity(0.12), in: Capsule())
    .accessibilityLabel("Account mode, \(mode.title)")
    .accessibilityIdentifier("modeBadge")
  }
}

struct StatusBadge: View {
  let title: String
  let symbol: String
  let color: Color

  var body: some View {
    Label(title, systemImage: symbol)
      .font(.caption.weight(.semibold))
      .foregroundStyle(color)
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(color.opacity(0.12), in: Capsule())
  }
}

struct ChangeLabel: View {
  let amount: Double
  let percent: Double
  var privacy = false

  var body: some View {
    let direction = amount < 0 ? "Down" : amount > 0 ? "Up" : "Unchanged"
    HStack(spacing: 5) {
      Image(
        systemName: privacy
          ? "eye.slash" : amount < 0 ? "arrow.down.right" : amount > 0 ? "arrow.up.right" : "minus")
      Text(
        privacy
          ? "••••••"
          : "\(FinancialFormatters.currency(amount, showSign: true))  \(FinancialFormatters.percent(percent, showSign: true))"
      )
      .monospacedDigit()
    }
    .foregroundStyle(privacy ? .secondary : TreasurySemanticColor.change(amount))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      privacy
        ? "Financial change hidden"
        : "\(direction), \(FinancialFormatters.spokenCurrency(abs(amount))), \(FinancialFormatters.percent(abs(percent)))"
    )
  }
}

struct LabeledValueRow: View {
  let label: String
  let value: String
  var symbol: String?
  var valueColor: Color = .primary

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      if let symbol { Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 22) }
      Text(label).foregroundStyle(.secondary)
      Spacer(minLength: 12)
      Text(value).foregroundStyle(valueColor).multilineTextAlignment(.trailing).monospacedDigit()
    }
    .font(.subheadline)
    .accessibilityElement(children: .combine)
  }
}

struct DisclosureNotice: View {
  let title: String
  let message: String
  var symbol = "info.circle"
  var color: Color = .secondary

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol).foregroundStyle(color)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.subheadline.weight(.semibold))
        Text(message).font(.caption).foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

struct EmptyStateView: View {
  let symbol: String
  let title: String
  let message: String
  var actionTitle: String?
  var action: (() -> Void)?

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: symbol)
    } description: {
      Text(message)
    } actions: {
      if let actionTitle, let action {
        Button(actionTitle, action: action).buttonStyle(.borderedProminent)
      }
    }
  }
}

struct PrivacyShieldView: View {
  let isLocked: Bool
  let unlock: () -> Void

  var body: some View {
    ZStack {
      Rectangle().fill(.background).ignoresSafeArea()
      VStack(spacing: 18) {
        BrandArtworkView(size: 76)
        Text("Metis").font(.title2.weight(.semibold))
        Text(
          isLocked
            ? "Sensitive information is locked."
            : "Financial information hidden while the app is inactive."
        )
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        if isLocked {
          Button("Unlock", action: unlock)
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("unlockAppButton")
        }
      }
      .padding(32)
    }
    .accessibilityElement(children: .contain)
  }
}

struct QRCodeView: View {
  let url: URL

  var body: some View {
    if let image = makeQRCode(from: url.absoluteString) {
      Image(uiImage: image)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .accessibilityLabel("QR code for the short-lived Robinhood authorization link")
    } else {
      Image(systemName: "qrcode")
        .resizable()
        .scaledToFit()
        .accessibilityLabel("QR code unavailable. Use Copy Robinhood Link instead.")
    }
  }

  private func makeQRCode(from string: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(string.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
    else { return nil }
    let context = CIContext(options: [.useSoftwareRenderer: false])
    guard let cgImage = context.createCGImage(output, from: output.extent) else { return nil }
    return UIImage(cgImage: cgImage)
  }
}

struct RiskProgressRow: View {
  let usage: RiskUsage

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Label(usage.title, systemImage: usage.symbol)
        Spacer()
        Text(valueText).monospacedDigit().foregroundStyle(.secondary)
      }
      .font(.subheadline)
      ProgressView(value: usage.fraction)
        .tint(usage.fraction > 0.85 ? .red : usage.fraction > 0.65 ? .orange : .accentColor)
        .accessibilityValue("\(Int(usage.fraction * 100)) percent of configured threshold")
    }
  }

  private var valueText: String {
    switch usage.displayUnit {
    case "currency":
      "\(FinancialFormatters.currency(usage.used)) of \(FinancialFormatters.currency(usage.limit))"
    case "reserve":
      "\(FinancialFormatters.percent(usage.used)) available · \(FinancialFormatters.percent(usage.limit)) minimum"
    default:
      "\(FinancialFormatters.percent(usage.used)) of \(FinancialFormatters.percent(usage.limit))"
    }
  }
}

struct LegalDocumentView: View {
  let document: LegalDocument

  var body: some View {
    List {
      if isAuthoritativePublication {
        Section("Publication") {
          LabeledContent("Version", value: document.version)
          LabeledContent("Status", value: "Approved and current")
          if let publishedAt = document.publishedAt {
            LabeledContent("Published") {
              Text(publishedAt, format: .dateTime.month(.abbreviated).day().year())
            }
          }
        }
        Section("Review before accepting") {
          Text(document.summary)
          if let contentURL = document.contentURL {
            Link(destination: contentURL) {
              Label("Open official publication", systemImage: "arrow.up.right.square")
            }
          }
          DisclosureNotice(
            title: "Current approved publication",
            message:
              "Your acknowledgement applies only to this exact version and published-content digest. A revised publication requires a new review.",
            symbol: "checkmark.shield",
            color: .green
          )
        }
      } else {
        Section {
          LabeledContent("Version", value: document.version)
          LabeledContent(
            "Production approved", value: document.productionApproved ? "Yes" : "No")
        }
        Section("Current publication status") {
          Text(document.summary)
          DisclosureNotice(
            title: "Nonproduction fixture",
            message:
              "This presentation and versioning boundary is complete, but final legal language must be published by authorized counsel before Live activation.",
            symbol: "exclamationmark.shield",
            color: .orange
          )
        }
      }
    }
    .navigationTitle(document.title)
    .navigationBarTitleDisplayMode(.inline)
  }

  private var isAuthoritativePublication: Bool {
    document.productionApproved && document.required && document.contentURL != nil
      && document.contentSHA256 != nil && document.publishedAt != nil
  }
}
