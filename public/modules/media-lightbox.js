import { escapeAttribute } from "./utils.js";

export function initMediaLightbox() {
  // Side-effect globals below preserve existing inline/event-delegated handlers.
}

window.playTrailer = function (el, videoKey, videoName) {
  const container = el.closest('.trailer-scroll-row');
  if (container) {
    container.querySelectorAll('.trailer-thumb-container').forEach(thumbCont => {
      if (thumbCont !== el && thumbCont.querySelector('iframe')) {
        const key = thumbCont.dataset.videoKey;
        const name = thumbCont.dataset.videoName;
        thumbCont.innerHTML = `
          <img class="trailer-thumb" src="https://img.youtube.com/vi/${key}/mqdefault.jpg" alt="${escapeAttribute(name)}" data-err="fav" />
          <div class="play-overlay">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
        `;
      }
    });
  }
  el.style.overflow = "visible";
  el.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoKey}?autoplay=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;"></iframe>`;
};

// Photo lightbox
(function () {
  let photos = [];
  let current = 0;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let lb = null;
  // drag state
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panAtDragX = 0;
  let panAtDragY = 0;

  function applyTransform() {
    const img = lb.querySelector('.photo-lightbox-img');
    const wrap = lb.querySelector('.photo-lightbox-img-wrap');
    if (scale === 1) {
      img.style.transform = '';
      wrap.classList.remove('grabbing');
      wrap.style.cursor = '';
    } else {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      wrap.style.cursor = dragging ? 'grabbing' : 'grab';
    }
  }

  function render() {
    const img = lb.querySelector('.photo-lightbox-img');
    img.src = photos[current];
    scale = 1; panX = 0; panY = 0;
    applyTransform();
    lb.querySelector('.photo-lightbox-counter').textContent = `${current + 1} / ${photos.length}`;
    lb.querySelector('.photo-lightbox-nav--prev').style.display = photos.length > 1 ? '' : 'none';
    lb.querySelector('.photo-lightbox-nav--next').style.display = photos.length > 1 ? '' : 'none';
  }

  function open(srcs, index) {
    photos = srcs;
    current = index;
    if (!lb) {
      lb = document.createElement('div');
      lb.className = 'photo-lightbox';
      lb.innerHTML = `
        <div class="photo-lightbox-img-wrap">
          <button class="photo-lightbox-nav photo-lightbox-nav--prev">&#8249;</button>
          <img class="photo-lightbox-img" alt="" draggable="false" />
          <button class="photo-lightbox-nav photo-lightbox-nav--next">&#8250;</button>
        </div>
        <div class="photo-lightbox-controls">
          <button class="photo-lightbox-btn" data-lb-zoom="-1">－</button>
          <button class="photo-lightbox-btn" data-lb-zoom="0">1:1</button>
          <button class="photo-lightbox-btn" data-lb-zoom="1">＋</button>
          <span class="photo-lightbox-counter"></span>
          <button class="photo-lightbox-btn" data-lb-close>✕</button>
        </div>
      `;

      // Zoom buttons + close
      lb.addEventListener('click', (e) => {
        if (dragging) return;
        if (e.target.dataset.lbClose !== undefined || e.target === lb) { close(); return; }
        const z = e.target.dataset.lbZoom;
        if (z === undefined) return;
        if (z === '0') { scale = 1; panX = 0; panY = 0; }
        else if (z === '1') scale = Math.min(scale + 0.5, 5);
        else { scale = Math.max(scale - 0.5, 0.5); if (scale === 1) { panX = 0; panY = 0; } }
        applyTransform();
      });

      // Wheel zoom
      const wrap = lb.querySelector('.photo-lightbox-img-wrap');
      wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.min(5, Math.max(0.5, scale - e.deltaY * 0.001));
        if (scale === 1) { panX = 0; panY = 0; }
        applyTransform();
      }, { passive: false });

      // Drag to pan
      wrap.addEventListener('mousedown', (e) => {
        if (scale <= 1) return;
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panAtDragX = panX;
        panAtDragY = panY;
        wrap.classList.add('grabbing');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panX = panAtDragX + (e.clientX - dragStartX);
        panY = panAtDragY + (e.clientY - dragStartY);
        applyTransform();
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove('grabbing');
        applyTransform();
      });

      // Nav arrows
      lb.querySelector('.photo-lightbox-nav--prev').addEventListener('click', (e) => { e.stopPropagation(); current = (current - 1 + photos.length) % photos.length; render(); });
      lb.querySelector('.photo-lightbox-nav--next').addEventListener('click', (e) => { e.stopPropagation(); current = (current + 1) % photos.length; render(); });

      document.body.appendChild(lb);
    }
    lb.style.display = 'flex';
    render();
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (lb) lb.style.display = 'none';
    dragging = false;
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => {
    if (!lb || lb.style.display === 'none') return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') { current = (current - 1 + photos.length) % photos.length; render(); }
    if (e.key === 'ArrowRight') { current = (current + 1) % photos.length; render(); }
  });

  window.openPhotoLightbox = function (srcs, index) { open(srcs, index); };
})();

