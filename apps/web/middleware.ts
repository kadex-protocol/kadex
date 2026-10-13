import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { notifySharePreview } from "@/lib/visitorServer";

export const config = { matcher: ["/opengraph-image.jpg", "/twitter-image.jpg"] };

export function middleware(request: NextRequest, event: NextFetchEvent) {
  event.waitUntil(notifySharePreview(request.headers, request.nextUrl.pathname));
  return NextResponse.next();
}
