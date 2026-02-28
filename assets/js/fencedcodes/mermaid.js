import {
  addElementToModal,
  displayModal,
  getLoadingHelper,
} from '../theme/modules/helpers.min.js';

// VARS //
// MAIN //
let mermaidConfig = {
  startOnLoad: true,
  securityLevel: 'loose',
  logLevel: 'fatal',
  theme: 'default',
};
document.addEventListener('DOMContentLoaded', function () {
  mermaid.mermaidAPI.initialize(mermaidConfig);
  renderMermaids();
});
// Render all mermaid graphs of the page
function renderMermaids() {
  let divm = Array.from(document.getElementsByClassName('language-mermaid'));
  for (let i = 0; i < divm.length; i++) {
    const mermaidId = `scMermaid${i}`;
    const graphDefinition = divm[i].textContent;
    divm[i].parentElement.replaceWith(
      getLoadingHelper('sc-mermaid-wrapper', mermaidId)
    );
    renderMermaid(mermaidId, graphDefinition);
  }
}
async function renderMermaid(mermaidId, graphDefinition) {
  const mermaidSvgId = `${mermaidId}-svg`;
  const mermaidWrapper = document.getElementById(mermaidId);
  const mermaidFragment = document.createDocumentFragment();
  const mermaidContainer = document.createElement('div');
  const mermaidSvgExport = document.createElement('a');
  const mermaidSvgExportIcon = document.createElement('i');
  mermaidContainer.classList.add('sc-mermaid-container');
  mermaidSvgExport.classList.add('is-action-button');
  mermaidSvgExportIcon.classList.add('fa-solid', 'fa-download');
  mermaidSvgExport.id = `${mermaidId}-export-svg`;
  mermaidSvgExport.title = svgDownloadLabel;
  mermaidFragment.appendChild(mermaidContainer);
  mermaidContainer.appendChild(mermaidSvgExport);
  mermaidSvgExport.appendChild(mermaidSvgExportIcon);
  mermaidWrapper.appendChild(mermaidFragment);
  try {
    // Mermaid v10+ may render asynchronously; support both sync and async return values.
    const renderResult = await mermaid.mermaidAPI.render(
      mermaidSvgId,
      graphDefinition
    );
    const svgCode =
      typeof renderResult === 'string' ? renderResult : renderResult?.svg;
    if (!svgCode) {
      throw new Error('Mermaid render returned empty SVG');
    }
    mermaidContainer.insertAdjacentHTML('afterbegin', svgCode);
    let mermaidRendered = document.getElementById(mermaidSvgId);
    if (!mermaidRendered) {
      throw new Error('Rendered Mermaid SVG was not found in DOM');
    }
    if (renderResult?.bindFunctions) {
      renderResult.bindFunctions(mermaidRendered);
    }
    let svgBlob = new Blob([mermaidRendered.outerHTML], {
      type: 'image/svg+xml;charset=utf-8',
    });
    URL.revokeObjectURL(mermaidSvgExport.href);
    mermaidSvgExport.href = URL.createObjectURL(svgBlob);
    mermaidSvgExport.download = mermaidId;
    mermaidRendered.classList.toggle('sc-mermaid-svg', true);
    mermaidRendered.classList.toggle('is-modal', false);
    /*
    mermaidRendered.addEventListener('click', function (e) {
      if (!e.target.closest('a')) {
        let el = this.cloneNode(true);
        addElementToModal(el);
        displayModal();
      }
    });
    */
    mermaidSvgExport.classList.toggle('is-hidden', false);
    mermaidWrapper.classList.toggle('is-loading', false);
  } catch (error) {
    const ed = document.createElement('div');
    ed.classList.add('sc-alert', 'sc-alert-error');
    ed.textContent = error?.message || String(error);
    ed.id = `${mermaidId}-error`;
    mermaidSvgExport.classList.toggle('is-hidden', true);
    mermaidWrapper.classList.toggle('is-loading', false);
    mermaidContainer.insertAdjacentElement('afterbegin', ed);
  }
}
