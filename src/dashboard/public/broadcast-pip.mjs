// The broadcast's picture-in-picture: home from above, a still picture the
// bot renders at most every 90 s (src/dashboard/public-home-view.ts). This
// file asks for it once a minute, loads it behind the one showing and
// crossfades, so the panel never flashes empty. The panel stays hidden until
// a picture exists, and hides again if the bot stops having one. It draws
// no text of its own; the caption is fixed copy in the page.
const POLL_MS = 60_000, RETRY_MS = 10_000;

/** Keeps the `pip` figure's two images current; `slot` is the figure, `view` holds the images. */
export function mountPip(slot) {
  const view = slot?.querySelector(".pip-view");
  if (!view) return;
  const images = [0, 1].map(() => {
    const img = document.createElement("img");
    img.alt = ""; img.width = 39; img.height = 39; img.decoding = "async";
    view.append(img);
    return img;
  });
  let front = 0, timer = null, version = 0;

  function next(ms) { clearTimeout(timer); timer = setTimeout(load, ms); }
  function load() {
    if (document.hidden) { next(POLL_MS); return; }
    const back = images[1 - front];
    back.onload = () => {
      back.classList.add("on");
      images[front].classList.remove("on");
      front = 1 - front;
      slot.hidden = false;
      next(POLL_MS);
    };
    back.onerror = () => {
      // 503: no picture yet, or none any more.
      slot.hidden = true;
      images.forEach((img) => img.classList.remove("on"));
      next(RETRY_MS);
    };
    back.src = `/api/public/home.png?v=${++version}`;
  }
  load();
}
