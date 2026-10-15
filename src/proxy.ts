import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refresca la sesión de Supabase y hace el chequeo optimista de autenticación.
 * La autorización real (tenant, módulo, permiso, MFA) ocurre en layouts y
 * Server Actions vía requireTenant / requirePlatformAdmin.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );
  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  const protectedArea = path.startsWith("/app") || path.startsWith("/superadmin");

  if (protectedArea && !data?.claims) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  // Superadmin exige MFA verificado en la sesión (aal2)
  if (path.startsWith("/superadmin") && data?.claims?.aal !== "aal2") {
    const url = request.nextUrl.clone();
    url.pathname = "/login/mfa";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  response.headers.set("x-request-id", crypto.randomUUID());
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/internal|api/webhooks).*)"],
};
