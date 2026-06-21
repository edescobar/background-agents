import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// When IFRAME_ALLOWED_ORIGINS is set (e.g. "https://ide.openkleo.com"),
// add Content-Security-Policy frame-ancestors so the app can be embedded
// in an iframe on the listed origins. Without this, the browser blocks
// framing by default (or Cloudflare Workers sets its own restrictive header).
const IFRAME_ORIGINS = process.env.IFRAME_ALLOWED_ORIGINS;

export function middleware(_request: NextRequest) {
  const response = NextResponse.next();

  if (IFRAME_ORIGINS) {
    response.headers.set("Content-Security-Policy", `frame-ancestors 'self' ${IFRAME_ORIGINS};`);
    // Also remove X-Frame-Options if present (it overrides CSP frame-ancestors).
    response.headers.delete("X-Frame-Options");
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, public assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
