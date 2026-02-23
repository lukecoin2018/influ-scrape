import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only allow these specific routes without authentication
  const publicPaths = ['/login', '/api/auth/login', '/api/auth/logout'];
  const isPublicPath = publicPaths.some(path => pathname === path || pathname.startsWith(path + '/'));
  
  // Skip static files and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.startsWith('/api/auth')
  ) {
    return NextResponse.next();
  }

  // If it's a public path, allow through
  if (isPublicPath) {
    return NextResponse.next();
  }

  // All other routes (including /) require authentication
  const sessionCookie = request.cookies.get('scraper_session');

  if (!sessionCookie || sessionCookie.value !== 'authenticated') {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths including root
     */
    '/(.*)',
  ],
};
