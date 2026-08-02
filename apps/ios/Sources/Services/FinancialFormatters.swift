import Foundation

enum FinancialFormatters {
  static func currency(_ value: Double, showSign: Bool = false, hide: Bool = false) -> String {
    guard !hide else { return "••••••" }
    let formatted = value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    if showSign, value > 0 { return "+\(formatted)" }
    return formatted
  }

  static func percent(_ value: Double, showSign: Bool = false) -> String {
    let sign = showSign && value > 0 ? "+" : ""
    return "\(sign)\(value.formatted(.number.precision(.fractionLength(2))))%"
  }

  static func quantity(_ value: Double) -> String {
    value.formatted(.number.precision(.fractionLength(0...4)))
  }

  static func relative(_ date: Date?) -> String {
    guard let date else { return "Not scheduled" }
    return date.formatted(.relative(presentation: .named, unitsStyle: .wide))
  }

  static func timestamp(_ date: Date) -> String {
    date.formatted(date: .abbreviated, time: .shortened)
  }

  static func timestampWithTimeZone(_ date: Date) -> String {
    let timeZone =
      TimeZone.current.abbreviation(for: date)
      ?? TimeZone.current.identifier.replacingOccurrences(of: "_", with: " ")
    return "\(date.formatted(date: .abbreviated, time: .standard)) · \(timeZone)"
  }

  static func spokenCurrency(_ value: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .spellOut
    let totalCents = Int((abs(value) * 100).rounded())
    let dollars = totalCents / 100
    let cents = totalCents % 100
    let dollarWords = formatter.string(from: NSNumber(value: dollars)) ?? String(dollars)
    let centWords = formatter.string(from: NSNumber(value: cents)) ?? String(cents)
    let sign = value < 0 ? "negative " : ""
    return "\(sign)\(dollarWords) dollars and \(centWords) cents"
  }
}
