import { describe, expect, it } from "vitest";
import { classifyLoginError, hasWrappingQuotes } from "@/lib/auth/login-errors";

describe("clasificación de errores de login", () => {
  it.each([
    [{ code: "invalid_credentials", status: 400, message: "Invalid login credentials" }, "credentials"],
    [{ status: 400, message: "Invalid login credentials" }, "credentials"],
    [{ code: "email_not_confirmed", status: 400 }, "unconfirmed"],
    [{ code: "over_request_rate_limit", status: 429 }, "rate_limited"],
    [{ status: 0, name: "AuthRetryableFetchError", message: "fetch failed" }, "auth_unavailable"],
    [{ status: 401, message: "Invalid API key" }, "auth_unavailable"],
    [{ status: 500, code: "unexpected_failure" }, "auth_unavailable"],
  ])("%j → %s", (err, kind) => expect(classifyLoginError(err)).toBe(kind));

  it("detecta valores pegados con comillas", () => {
    expect(hasWrappingQuotes('"https://x.supabase.co"')).toBe(true);
    expect(hasWrappingQuotes("'eyJhbGci'")).toBe(true);
    expect(hasWrappingQuotes("https://x.supabase.co")).toBe(false);
    expect(hasWrappingQuotes(undefined)).toBe(false);
  });
});
