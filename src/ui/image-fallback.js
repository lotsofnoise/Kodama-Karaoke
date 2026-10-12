// Artwork that fails to load falls back to the placeholder, not to the browser's broken-image
// icon.
//
// Where a track simply has no artwork, the views draw the same placeholder (NOTE_COVER over the
// --placeholder-gradient, see .img-failed in index.css). A thumbnail that exists but does not
// arrive - a dead ytimg URL, a flaky connection, the image proxy having a bad moment - fell
// through that: the <img> stayed, and the browser drew its own torn-page glyph, which looks like
// a bug in the app rather than a missing picture.
//
// Done here, once, rather than as an onError on each of the ~50 <img> tags across 27 files.
// Resource errors do not bubble, hence the capture phase; that is also what makes this reach
// images React has not rendered yet, and every window, since they all boot through main.jsx.

// A music note, drawn over the placeholder gradient (which .img-failed puts behind it). Pointing
// src here is what removes the broken-image glyph: the element keeps its CSS size, and shows
// this instead of nothing.
export const NOTE_COVER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<g fill="#ffffff" fill-opacity="0.38">' +
    '<ellipse cx="45" cy="67" rx="12.5" ry="9.5" transform="rotate(-22 45 67)"/>' +
    '<rect x="53.5" y="24" width="5" height="44" rx="2.5"/>' +
    '<path d="M56 24c2 9 17 11 17 25 0 4-1.2 7.5-3.4 10.5 1.4-11-6-16.5-13.6-17.5z"/>' +
    "</g>" +
    "</svg>"
  );

export function installImageFallback(target = document) {
  target.addEventListener(
    "error",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLImageElement)) return;
      // Only the placeholder itself failing is left alone (nothing better to show, and swapping
      // again would loop). A flag on the element was not enough: one <img> is reused for song
      // after song (the player's cover), and once a single cover had failed, every later one
      // that failed showed the broken-image glyph.
      if (el.src === NOTE_COVER) return;
      el.dataset.imgFailed = "1";
      // Alt text would be drawn in place of the picture, which is the same problem again.
      el.alt = "";
      el.src = NOTE_COVER;
      el.classList.add("img-failed");
    },
    true
  );
  // The same element then loading a real picture (the next song's cover) drops the placeholder
  // look again.
  target.addEventListener(
    "load",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLImageElement) || el.src === NOTE_COVER || !el.dataset.imgFailed) return;
      delete el.dataset.imgFailed;
      el.classList.remove("img-failed");
    },
    true
  );
}
