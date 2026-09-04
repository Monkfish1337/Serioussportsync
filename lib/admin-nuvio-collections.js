'use strict';

const settings = require('./nuvio-collection-settings');
const promotions = require('./promotions');

const ARTWORK_CHOICES = [
  { value: 'promotion', label: 'Use first promotion artwork (fallback: SSS banner)' },
  { value: '/assets/logo-banner.png', label: 'SSS banner' },
  { value: '/assets/collection-combat-sports.png', label: 'Combat Sports' },
  { value: '/assets/collection-wrestling.png', label: 'Wrestling' },
  { value: '/assets/collection-football.png', label: 'Football' },
  { value: '/assets/collection-motorsport.png', label: 'Motorsport' },
  { value: 'custom', label: 'Custom image URL' },
];

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function checked(value) { return value ? ' checked' : ''; }

function artworkSelection(artwork) {
  const known = ARTWORK_CHOICES.some((choice) => choice.value === artwork && choice.value !== 'custom');
  return { choice: known ? artwork : 'custom', custom: known ? '' : artwork };
}

function artworkOptions(selected) {
  return ARTWORK_CHOICES.map((choice) => '<option value="' + escapeHtml(choice.value) + '"'
    + (choice.value === selected ? ' selected' : '') + '>' + escapeHtml(choice.label) + '</option>').join('');
}

function promotionChoices(selectedIds, prefix) {
  const selected = new Set(selectedIds || []);
  return promotions.enabled.map((promotion) => '<label class="form-selectgroup-item">'
    + '<input type="checkbox" name="promotions" value="' + escapeHtml(promotion.id) + '" class="form-selectgroup-input"'
    + checked(selected.has(promotion.id)) + '>'
    + '<span class="form-selectgroup-label">' + escapeHtml(promotion.name) + '</span>'
    + '</label>').join('') || '<span class="text-secondary">Create a promotion first.</span>';
}

function resolvedPreview(folder) {
  if (folder.artwork !== 'promotion') return folder.artwork || '/assets/logo-banner.png';
  for (const promotionId of folder.promotions || []) {
    const promotion = promotions.enabled.find((item) => item.id === promotionId);
    const defaults = promotion && promotion.defaults || {};
    const image = defaults.fanart || defaults.poster || defaults.logo;
    if (image) return image;
  }
  return '/assets/logo-banner.png';
}

function folderCard(folder) {
  const artwork = artworkSelection(folder.artwork);
  const includedNames = folder.promotions.map((promotionId) => {
    const promotion = promotions.enabled.find((item) => item.id === promotionId);
    return promotion ? promotion.name : promotionId;
  });
  return '<div class="card mb-3"><form method="POST" action="/admin/nuvio-collections/folders/' + encodeURIComponent(folder.id) + '/save">'
    + '<div class="row g-0">'
    + '<div class="col-md-4"><div class="ratio ratio-16x9 h-100"><img src="' + escapeHtml(resolvedPreview(folder)) + '" alt="" class="object-fit-cover rounded-start" onerror="this.src=\'/assets/logo-banner.png\'"></div></div>'
    + '<div class="col-md-8"><div class="card-body">'
    + '<div class="row g-3"><div class="col-md-7"><label class="form-label">Folder title</label><input class="form-control" required maxlength="80" name="title" value="' + escapeHtml(folder.title) + '"></div>'
    + '<div class="col-md-5"><label class="form-label">Tile shape</label><select class="form-select" name="tileShape">'
    + settings.TILE_SHAPES.map((shape) => '<option value="' + shape + '"' + (folder.tileShape === shape ? ' selected' : '') + '>' + shape + '</option>').join('') + '</select></div></div>'
    + '<div class="mt-3"><label class="form-label">Folder image</label><select class="form-select artwork-choice" name="artworkChoice">' + artworkOptions(artwork.choice) + '</select></div>'
    + '<div class="mt-2 custom-artwork"><label class="form-label">Custom image URL</label><input class="form-control text-mono" type="url" name="customArtwork" value="' + escapeHtml(artwork.custom) + '" placeholder="https://example.com/mlb-collection.jpg"></div>'
    + '<details class="mt-3"><summary class="text-secondary">Included promotions (' + escapeHtml(String(folder.promotions.length)) + '): ' + escapeHtml(includedNames.join(', ')) + '</summary><div class="form-selectgroup mt-2">' + promotionChoices(folder.promotions, folder.id) + '</div></details>'
    + '<label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="hideTitle" value="1"' + checked(folder.hideTitle) + '><span class="form-check-label">Hide the folder title over artwork</span></label>'
    + '<div class="d-flex gap-2 mt-3"><button class="btn btn-primary" type="submit">Save folder</button>'
    + '<button class="btn btn-outline-danger" type="submit" formaction="/admin/nuvio-collections/folders/' + encodeURIComponent(folder.id) + '/delete" onclick="return confirm(\'Remove this folder from the Nuvio export? Promotions and events are not deleted.\')">Remove</button></div>'
    + '</div></div></div></form></div>';
}

function renderBody(opts) {
  opts = opts || {};
  const state = settings.load();
  const assigned = new Set(state.folders.flatMap((folder) => folder.promotions || []));
  const unassigned = promotions.enabled.filter((promotion) => !assigned.has(promotion.id));
  const requestedPromotion = promotions.enabled.some((promotion) => promotion.id === opts.promotion)
    ? opts.promotion : '';
  const flash = opts.flash ? '<div class="alert alert-info">' + escapeHtml(opts.flash) + '</div>' : '';
  const unassignedHtml = unassigned.length
    ? '<div class="alert alert-warning"><strong>Not yet in the Nuvio collection:</strong> '
      + unassigned.map((promotion) => '<a class="alert-link" href="/admin/nuvio-collections?promotion=' + encodeURIComponent(promotion.id) + '#add-folder">' + escapeHtml(promotion.name) + '</a>').join(', ') + '</div>'
    : '<div class="alert alert-success">Every enabled promotion is included in a Nuvio folder.</div>';
  const folderHtml = state.folders.map(folderCard).join('') || '<div class="alert alert-secondary">No folders yet. Add one below.</div>';
  const backdrop = artworkSelection(state.collection.backdropImage);
  const newArtwork = requestedPromotion ? 'promotion' : '/assets/logo-banner.png';
  // The Configure page embeds this editor, so the page header is optional:
  // there it already sits under a section heading of its own.
  const header = opts.embedded ? '' : `
    <div class="page-header"><div class="row align-items-center"><div class="col"><h2 class="page-title">Nuvio Collections</h2><p class="text-secondary mt-1">Choose which promotions appear in Nuvio, how they are grouped, and the artwork used for each folder.</p></div><div class="col-auto"><a class="btn btn-primary" href="/account/nuvio-collections.json" download>Download current JSON</a></div></div></div>`;
  return `
    ${header}
    ${flash}
    ${unassignedHtml}
    <div class="card mb-4"><div class="card-header"><h3 class="card-title">Collection settings</h3></div><div class="card-body"><form method="POST" action="/admin/nuvio-collections/save">
      <div class="row g-3"><div class="col-md-6"><label class="form-label">Collection title</label><input class="form-control" name="title" required maxlength="80" value="${escapeHtml(state.collection.title)}"></div>
      <div class="col-md-6"><label class="form-label">Collection backdrop</label><input class="form-control text-mono" type="text" name="backdropImage" value="${escapeHtml(backdrop.custom || state.collection.backdropImage)}" placeholder="https://example.com/sss-banner.jpg"><small class="text-secondary">Keep the bundled path or paste a public HTTPS image URL.</small></div></div>
      <div class="d-flex flex-wrap gap-4 mt-3"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="pinToTop" value="1"${checked(state.collection.pinToTop)}><span class="form-check-label">Pin collection to top</span></label>
      <label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="showAllTab" value="1"${checked(state.collection.showAllTab)}><span class="form-check-label">Show All tab</span></label></div>
      <button class="btn btn-primary mt-3" type="submit">Save collection</button>
    </form></div></div>
    <h3 class="mb-3">Folders</h3>
    ${folderHtml}
    <div class="card" id="add-folder"><div class="card-header"><h3 class="card-title">Add collection folder</h3></div><div class="card-body"><form method="POST" action="/admin/nuvio-collections/folders/create">
      <div class="row g-3"><div class="col-md-7"><label class="form-label">Folder title</label><input class="form-control" name="title" required maxlength="80" value="${escapeHtml(requestedPromotion ? (promotions.enabled.find((promotion) => promotion.id === requestedPromotion) || {}).name : '')}" placeholder="Major League Baseball"></div>
      <div class="col-md-5"><label class="form-label">Tile shape</label><select class="form-select" name="tileShape"><option value="landscape">landscape</option><option value="square">square</option><option value="poster">poster</option></select></div></div>
      <div class="mt-3"><label class="form-label">Folder image</label><select class="form-select artwork-choice" name="artworkChoice">${artworkOptions(newArtwork)}</select></div>
      <div class="mt-2 custom-artwork"><label class="form-label">Custom image URL</label><input class="form-control text-mono" type="url" name="customArtwork" placeholder="https://example.com/mlb-collection.jpg"></div>
      <div class="mt-3"><label class="form-label">Promotions in this folder</label><div class="form-selectgroup">${promotionChoices(requestedPromotion ? [requestedPromotion] : [], 'new')}</div></div>
      <label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="hideTitle" value="1"><span class="form-check-label">Hide the folder title over artwork</span></label>
      <button class="btn btn-primary mt-3" type="submit">Add folder</button>
    </form></div></div>
    <script>(function(){
      function update(select){var wrap=select.parentElement.nextElementSibling;if(!wrap||!wrap.classList.contains('custom-artwork'))return;wrap.style.display=select.value==='custom'?'':'none';}
      document.querySelectorAll('.artwork-choice').forEach(function(select){select.addEventListener('change',function(){update(select);});update(select);});
    })();</script>`;
}

function folderInput(body) {
  body = body || {};
  const artwork = body.artworkChoice === 'custom' ? body.customArtwork : body.artworkChoice;
  if (!String(artwork || '').trim()) throw new Error('Enter a custom image URL');
  return {
    title: body.title,
    promotions: body.promotions,
    artwork,
    tileShape: body.tileShape,
    hideTitle: body.hideTitle === '1' || body.hideTitle === 'on',
  };
}

module.exports = { ARTWORK_CHOICES, renderBody, folderInput, resolvedPreview };
