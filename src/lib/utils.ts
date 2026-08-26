import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Defensive normalizer for topic/article image URLs.
 *
 * The API contract says imageUrl is string | null, but a malformed cache
 * entry (e.g. an accidentally-nested object) once made it to clients and
 * crashed the feed (imageUrl.split is not a function). Every consumer that
 * does string operations on an image URL goes through this helper so bad
 * data degrades to "no image" instead of an ErrorBoundary crash.
 */
export function safeImageUrl(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}
