import nodemailer, { type Transporter } from "nodemailer";
import { DomainError } from "@whox/contracts";

export interface DesktopLinkEmail {
  readonly recipient: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface DesktopLinkEmailSender {
  send(message: DesktopLinkEmail): Promise<void>;
}

export interface SmtpDesktopLinkEmailSenderOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly from: string;
  readonly desktopHandoffUrl: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function desktopAuthorizationHandoffUrl(handoffUrl: URL, authorizationUrl: URL): URL {
  if (handoffUrl.protocol !== "https:" || handoffUrl.search !== "" || handoffUrl.hash !== "" || authorizationUrl.protocol !== "https:") {
    throw new DomainError("DESKTOP_LINK_INVALID", "The desktop authorization link is invalid", 500);
  }
  const result = new URL(handoffUrl);
  result.hash = new URLSearchParams({ authorization: authorizationUrl.href }).toString();
  return result;
}

export function validatedRobinhoodEmail(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("ROBINHOOD_EMAIL_INVALID", "Enter a valid Robinhood email address", 422);
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !emailPattern.test(normalized) || /[\r\n]/.test(normalized)) {
    throw new DomainError("ROBINHOOD_EMAIL_INVALID", "Enter a valid Robinhood email address", 422);
  }
  return normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

export class SmtpDesktopLinkEmailSender implements DesktopLinkEmailSender {
  readonly #transport: Transporter;
  readonly #from: string;
  readonly #desktopHandoffUrl: URL;

  public constructor(options: SmtpDesktopLinkEmailSenderOptions) {
    if (!options.host || !Number.isInteger(options.port) || options.port < 1 || options.port > 65_535 || !options.username || !options.password) {
      throw new DomainError("SMTP_CONFIGURATION_INVALID", "Desktop-link email delivery is not configured", 500);
    }
    this.#from = validatedRobinhoodEmail(options.from);
    this.#desktopHandoffUrl = new URL(options.desktopHandoffUrl);
    if (this.#desktopHandoffUrl.protocol !== "https:" || this.#desktopHandoffUrl.search !== "" || this.#desktopHandoffUrl.hash !== "") {
      throw new DomainError("SMTP_CONFIGURATION_INVALID", "Desktop handoff URL is invalid", 500);
    }
    this.#transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      requireTLS: options.port !== 465,
      auth: { user: options.username, pass: options.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  public async send(message: DesktopLinkEmail): Promise<void> {
    const recipient = validatedRobinhoodEmail(message.recipient);
    const link = new URL(message.authorizationUrl);
    if (link.protocol !== "https:" || !Number.isFinite(Date.parse(message.expiresAt))) {
      throw new DomainError("DESKTOP_LINK_INVALID", "The desktop authorization link is invalid", 500);
    }
    const expires = new Date(message.expiresAt).toUTCString();
    const desktopLink = desktopAuthorizationHandoffUrl(this.#desktopHandoffUrl, link);
    try {
      await this.#transport.sendMail({
        from: `Yield <${this.#from}>`,
        to: recipient,
        subject: "Connect your Robinhood account to Yield",
        text: `Open this single-use link on a Mac or PC desktop browser:\n\n${desktopLink.href}\n\nRobinhood does not complete Agentic Trading connections in a mobile browser. The Robinhood email field is prefilled for ${recipient}. This link expires ${expires}. If you did not request it, do not open it. Yield never asks for your Robinhood password by email.`,
        html: `<p><strong>Open this link on a Mac or PC desktop browser.</strong></p><p><a href="${escapeHtml(desktopLink.href)}">Connect Robinhood to Yield</a></p><p>Robinhood does not complete Agentic Trading connections in a mobile browser. The Robinhood email field is prefilled for <strong>${escapeHtml(recipient)}</strong>. This link expires ${escapeHtml(expires)}.</p><p>If you did not request it, do not open it. Yield never asks for your Robinhood password by email.</p>`,
      });
    } catch {
      throw new DomainError("DESKTOP_LINK_EMAIL_UNAVAILABLE", "The desktop link could not be emailed. Try again shortly", 503);
    }
  }
}

export class UnavailableDesktopLinkEmailSender implements DesktopLinkEmailSender {
  public async send(): Promise<void> {
    throw new DomainError("DESKTOP_LINK_EMAIL_UNAVAILABLE", "Desktop-link email delivery is not configured", 503);
  }
}
