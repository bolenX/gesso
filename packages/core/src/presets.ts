// Common output sizes, in pixels. Safe zones are the margins platforms cover with
// their own UI (profile bars, captions, buttons); keep text and logos out of them.

export type Preset = {
  name: string;
  w: number;
  h: number;
  /** Margins in pixels the platform's UI may cover: [top, right, bottom, left]. */
  safe?: [number, number, number, number];
};

export const PRESETS: Record<string, Preset> = {
  "instagram-square": { name: "Instagram square 1:1", w: 1080, h: 1080 },
  "instagram-portrait": { name: "Instagram portrait 4:5", w: 1080, h: 1350 },
  "instagram-story": { name: "Instagram story 9:16", w: 1080, h: 1920, safe: [250, 60, 340, 60] },
  "instagram-reel": { name: "Instagram reel cover 9:16", w: 1080, h: 1920, safe: [250, 120, 420, 60] },
  "tiktok": { name: "TikTok 9:16", w: 1080, h: 1920, safe: [160, 140, 480, 60] },
  "facebook-post": { name: "Facebook post", w: 1200, h: 630 },
  "facebook-cover": { name: "Facebook cover", w: 1640, h: 624 },
  "linkedin-post": { name: "LinkedIn post", w: 1200, h: 627 },
  "x-post": { name: "X post 16:9", w: 1600, h: 900 },
  "x-header": { name: "X header", w: 1500, h: 500 },
  "youtube-thumbnail": { name: "YouTube thumbnail", w: 1280, h: 720, safe: [0, 0, 110, 0] },
  "pinterest-pin": { name: "Pinterest pin 2:3", w: 1000, h: 1500 },
  "og-image": { name: "Link preview (Open Graph)", w: 1200, h: 630 },
  "hd": { name: "HD 16:9", w: 1920, h: 1080 },
  "4k": { name: "4K 16:9", w: 3840, h: 2160 },
  "iab-300x250": { name: "Medium rectangle 300×250", w: 300, h: 250 },
  "iab-336x280": { name: "Large rectangle 336×280", w: 336, h: 280 },
  "iab-728x90": { name: "Leaderboard 728×90", w: 728, h: 90 },
  "iab-970x250": { name: "Billboard 970×250", w: 970, h: 250 },
  "iab-300x600": { name: "Half page 300×600", w: 300, h: 600 },
  "iab-160x600": { name: "Wide skyscraper 160×600", w: 160, h: 600 },
  "iab-320x50": { name: "Mobile banner 320×50", w: 320, h: 50 },
  "a3": { name: "A3 at 300 dpi", w: 3508, h: 4961 },
  "a4": { name: "A4 at 300 dpi", w: 2480, h: 3508 },
  "a5": { name: "A5 at 300 dpi", w: 1748, h: 2480 },
  "letter": { name: "US Letter at 300 dpi", w: 2550, h: 3300 },
  "poster-18x24": { name: "Poster 18×24 in at 150 dpi", w: 2700, h: 3600 },
  "business-card": { name: "Business card 3.5×2 in at 300 dpi", w: 1050, h: 600 },
};

export function presetList(): string {
  return Object.entries(PRESETS)
    .map(([id, p]) => `${id} (${p.w}×${p.h})`)
    .join(", ");
}
