import { LightningElement, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import saveTemplate from '@salesforce/apex/PandoraTemplateController.saveTemplate';
import getTemplates from '@salesforce/apex/PandoraTemplateController.getTemplates';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import VERSION_DATA_URL from '@salesforce/schema/ContentDocument.LatestPublishedVersion.VersionDataUrl';

const SLIDE_W_IN = 13.333; const SLIDE_H_IN = 7.5; const NUDGE_STEP = 0.05;
const FONT_OPTIONS = [{ label: 'Arial', value: 'Arial' }, { label: 'Calibri', value: 'Calibri' }, { label: 'Segoe UI', value: 'Segoe UI' }];
const ALIGN_OPTIONS = [{ label: 'Izquierda', value: 'left' }, { label: 'Centro', value: 'center' }, { label: 'Derecha', value: 'right' }];

const DEFAULT_LAYOUT = {
  theme: { primaryColor: '#0070c0', secondaryColor: '#64748b', fontName: 'Arial' },
  slides: {
    portada: { bgDocId: null, title: { x: 4.5, y: 0.6, w: 8.0, h: 2.0, fontSize: 28, color: '#0070c0', align: 'left', bold: true }, subtitle: { x: 4.5, y: 3.0, w: 8.0, h: 1.0, fontSize: 16, color: '#64748b', align: 'left' } },
    contenido: { bgDocId: null, title: { x: 1.2, y: 0.2, w: 10.0, h: 0.8, fontSize: 22, color: '#0070c0', align: 'left', bold: true }, subtitle: { x: 1.2, y: 1.0, w: 10.0, h: 0.5, fontSize: 14, color: '#64748b', align: 'left' }, table: { startY: 1.5 } },
    cierre: { bgDocId: null, title: { x: 2.6, y: 3.2, w: 8.0, h: 2.0, fontSize: 28, color: '#0070c0', align: 'center', bold: true }, subtitle: { x: 2.6, y: 5.5, w: 8.0, h: 1.0, fontSize: 16, color: '#64748b', align: 'center' } }
  }
};

export default class PandoraTemplateBuilder extends LightningElement {
  wiredTemplatesResult; templatesRaw = [];
  @track templateOptions = []; @track selectedTemplateId; @track isSaving = false; @track errorMessage = '';
  @track isCreateOpen = false; @track newTemplateName = ''; @track cloneFromId = ''; @track newActive = true;
  @track templateName = ''; @track colorPrimary = DEFAULT_LAYOUT.theme.primaryColor; @track colorSecondary = DEFAULT_LAYOUT.theme.secondaryColor; @track fontFamily = DEFAULT_LAYOUT.theme.fontName; @track isActive = true;
  @track activeSlide = 'portada'; @track selectedElement = 'title'; @track isDirty = false; @track testPreviewText = '';

  layout = this.clone(DEFAULT_LAYOUT);
  dragging = false; raf = null; pointerOffset = { x: 0, y: 0 }; _boundOnMove; _boundOnUp;

  get fontOptions() { return FONT_OPTIONS; } get elementFontOptions() { return [{ label: '(Global)', value: '' }, ...FONT_OPTIONS]; } get alignOptions() { return ALIGN_OPTIONS; }
  get portadaDocId() { return this.layout?.slides?.portada?.bgDocId; } get contenidoDocId() { return this.layout?.slides?.contenido?.bgDocId; } get cierreDocId() { return this.layout?.slides?.cierre?.bgDocId; }
  @wire(getRecord, { recordId: '$portadaDocId', fields: [VERSION_DATA_URL] }) portadaDoc; @wire(getRecord, { recordId: '$contenidoDocId', fields: [VERSION_DATA_URL] }) contenidoDoc; @wire(getRecord, { recordId: '$cierreDocId', fields: [VERSION_DATA_URL] }) cierreDoc;
  get portadaBgUrl() { return this.portadaDocId ? getFieldValue(this.portadaDoc?.data, VERSION_DATA_URL) : ''; } get contenidoBgUrl() { return this.contenidoDocId ? getFieldValue(this.contenidoDoc?.data, VERSION_DATA_URL) : ''; } get cierreBgUrl() { return this.cierreDocId ? getFieldValue(this.cierreDoc?.data, VERSION_DATA_URL) : ''; }
  formatTemplateComboLabel(t) {
    const flag = t.Activo__c ? '' : ' · inactiva';
    let suf = '';
    if (t.LastModifiedDate) {
      try {
        const d = new Date(t.LastModifiedDate);
        suf = ` · ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      } catch (e) { /* ignore */ }
    }
    return `${t.Name}${flag}${suf}`;
  }

  @wire(getTemplates) wiredTemplates(result) {
    this.wiredTemplatesResult = result;
    if (result.data) {
      this.templatesRaw = result.data;
      this.templateOptions = result.data.map(t => ({
        label: this.formatTemplateComboLabel(t),
        value: t.Id
      }));
    }
  }

  get isEditMode() { return !!this.selectedTemplateId; }
  get allTemplateOptions() {
    const rows = (this.templatesRaw || []).map(t => ({ label: t.Name, value: t.Id }));
    return [{ label: '— Sin clonar (diseño por defecto) —', value: '' }, ...rows];
  }
  get acceptedFormats() { return ['.png', '.jpg', '.jpeg']; }
  get slidePillPortadaClass() { return `slide-pill ${this.activeSlide === 'portada' ? 'slide-pill--active' : ''}`; }
  get slidePillContenidoClass() { return `slide-pill ${this.activeSlide === 'contenido' ? 'slide-pill--active' : ''}`; }
  get slidePillCierreClass() { return `slide-pill ${this.activeSlide === 'cierre' ? 'slide-pill--active' : ''}`; }
  get titleElementPillClass() { return this.selectedElement === 'title' ? 'slide-pill slide-pill--active' : 'slide-pill'; }
  get subtitleElementPillClass() { return this.selectedElement === 'subtitle' ? 'slide-pill slide-pill--active' : 'slide-pill'; }
  get activeSlideLabel() { return this.activeSlide === 'portada' ? 'Portada' : this.activeSlide === 'contenido' ? 'Contenido' : 'Cierre'; } get slideTag() { return `SLIDE: ${this.activeSlide.toUpperCase()}`; }
  get previewTitleText() { if(this.selectedElement === 'title' && this.testPreviewText) return this.testPreviewText; return this.activeSlide === 'cierre' ? '¡MUCHAS GRACIAS!' : 'TÍTULO DE EJEMPLO LARGO PARA VER AJUSTE DE CAJA'; }
  get previewSubtitleText() { if(this.selectedElement === 'subtitle' && this.testPreviewText) return this.testPreviewText; return 'Subtítulo o descripción de la diapositiva'; }
  get isContenido() { return this.activeSlide === 'contenido'; } get isSaveDisabled() { return this.isSaving || !this.isDirty; }
  get titleClasses() { return `mock-element draggable ${this.selectedElement === 'title' ? 'is-selected' : ''}`; }
  get subtitleClasses() { return `mock-element draggable ${this.selectedElement === 'subtitle' ? 'is-selected' : ''}`; }
  get currentEl() { return this.layout.slides[this.activeSlide][this.selectedElement]; }
  get currentXIn() { return this.currentEl.x; } get currentYIn() { return this.currentEl.y; } get currentWIn() { return this.currentEl.w || 8.0; } get currentHIn() { return this.currentEl.h || 1.0; }
  get currentFontSize() { return this.currentEl.fontSize; } get currentColor() { return this.currentEl.color || (this.selectedElement === 'title' ? this.colorPrimary : this.colorSecondary); } get currentFontFace() { return this.currentEl.fontFace || ''; } get currentBold() { return !!this.currentEl.bold; } get currentItalic() { return !!this.currentEl.italic; } get currentAlign() { return this.currentEl.align || 'left'; }
  get currentXPercent() { return Math.round((this.currentXIn / SLIDE_W_IN) * 100); } get currentYPercent() { return Math.round((this.currentYIn / SLIDE_H_IN) * 100); } get tableStartY() { return this.layout.slides.contenido.table.startY; }
  
  get mockupSlideStyle() { let url = this.activeSlide === 'portada' ? this.portadaBgUrl : this.activeSlide === 'contenido' ? this.contenidoBgUrl : this.cierreBgUrl; let style = `font-family:${this.fontFamily}; background-color:white;`; if (url) style += `background-image:url('${url}'); background-size:cover; background-position:center;`; return style; }
  get mockupTitleStyle() { return this.elementStyle(this.layout.slides[this.activeSlide].title); } get mockupSubtitleStyle() { return this.elementStyle(this.layout.slides[this.activeSlide].subtitle); }
  get mockupTableLineStyle() { return `top:${this.clampRaw((this.layout.slides.contenido.table.startY / SLIDE_H_IN) * 100, 0, 95)}%;`; }

  elementStyle(el) {
    const l = this.clampRaw((el.x / SLIDE_W_IN) * 100, 0, 95); const t = this.clampRaw((el.y / SLIDE_H_IN) * 100, 0, 95);
    const w = el.w ? (el.w / SLIDE_W_IN) * 100 : (8.0 / SLIDE_W_IN) * 100; const h = el.h ? (el.h / SLIDE_H_IN) * 100 : (1.0 / SLIDE_H_IN) * 100;
    const size = Math.max(10, el.fontSize * 0.9); const font = el.fontFace && el.fontFace.trim() ? el.fontFace : this.fontFamily;
    const slide = this.layout.slides[this.activeSlide];
    const isTitle = el === slide.title;
    const color = el.color || (isTitle ? this.colorPrimary : this.colorSecondary);
    const weight = el.bold ? 700 : 400; const italic = el.italic ? 'italic' : 'normal'; const align = el.align || 'left';
    return `left:${l}%; top:${t}%; width:${w}%; height:${h}%; font-size:${size}px; color:${color}; font-family:${font}; font-weight:${weight}; font-style:${italic}; text-align:${align};`;
  }

  registerChange() { this.isDirty = true; this.layout = this.clone(this.layout); }
  handleSlideTab(e) {
    const v = e.currentTarget?.dataset?.slide;
    if (!v) return;
    this.activeSlide = v;
    this.selectedElement = 'title';
    this.testPreviewText = '';
  }
  selectTitle() { this.selectedElement = 'title'; this.testPreviewText = ''; } selectSubtitle() { this.selectedElement = 'subtitle'; this.testPreviewText = ''; }
  handleTemplateChange(e) { const r = this.templatesRaw?.find(t => t.Id === e.detail.value); if (!r) return; this.selectedTemplateId = r.Id; this.templateName = r.Name; this.colorPrimary = r.Color_Primario__c || '#0070c0'; this.colorSecondary = r.Color_Secundario__c || '#64748b'; this.fontFamily = r.Fuente_Corporativa__c || 'Arial'; this.isActive = r.Activo__c; this.layout = this.coerceLayout(r.Configuracion_JSON__c); this.isDirty = false; this.errorMessage = ''; }
  handleBgUploadFinished(e) { const f = e.detail.files || []; if (!f.length) return; this.layout.slides[this.activeSlide].bgDocId = f[0].documentId; this.registerChange(); this.toast('Éxito', `Fondo actualizado.`, 'success'); }
  clearBackgroundForActiveSlide() { this.layout.slides[this.activeSlide].bgDocId = null; this.registerChange(); }
  handleField(e) { this[e.target.dataset.field] = e.target.value; this.isDirty = true; } handleFontChange(e) { this.fontFamily = e.detail.value; this.isDirty = true; } handleToggleActive(e) { this.isActive = e.target.checked; this.isDirty = true; }
  handleXPercent(e) { this.setElX((parseInt(e.detail.value, 10) / 100) * SLIDE_W_IN); } handleYPercent(e) { this.setElY((parseInt(e.detail.value, 10) / 100) * SLIDE_H_IN); } handleFontSize(e) { this.currentEl.fontSize = parseInt(e.detail.value, 10); this.registerChange(); } handleTestTextChange(e) { this.testPreviewText = e.detail.value; }
  handleXIn(e) { const v = parseFloat(e.detail.value); if (Number.isFinite(v)) this.setElX(v); } handleYIn(e) { const v = parseFloat(e.detail.value); if (Number.isFinite(v)) this.setElY(v); }
  handleWIn(e) { const v = parseFloat(e.detail.value); if (Number.isFinite(v)) { this.currentEl.w = v; this.registerChange(); } } handleHIn(e) { const v = parseFloat(e.detail.value); if (Number.isFinite(v)) { this.currentEl.h = v; this.registerChange(); } }
  handleColor(e) { this.currentEl.color = e.target.value; this.registerChange(); } handleElementFontFace(e) { this.currentEl.fontFace = e.detail.value; this.registerChange(); } handleBold(e) { this.currentEl.bold = e.target.checked; this.registerChange(); } handleItalic(e) { this.currentEl.italic = e.target.checked; this.registerChange(); } handleAlign(e) { this.currentEl.align = e.detail.value; this.registerChange(); } handleTableStartY(e) { const y = parseFloat(e.detail.value); if (Number.isFinite(y)) { this.layout.slides.contenido.table.startY = y; this.registerChange(); } }
  alignCenterH() { this.setElX(SLIDE_W_IN / 2 - (this.currentWIn / 2)); } alignCenterV() { this.setElY(SLIDE_H_IN / 2 - (this.currentHIn / 2)); }

  handleKeyDown(e) { if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); let cx = this.currentEl.x; let cy = this.currentEl.y; if (e.key === 'ArrowUp') cy -= NUDGE_STEP; if (e.key === 'ArrowDown') cy += NUDGE_STEP; if (e.key === 'ArrowLeft') cx -= NUDGE_STEP; if (e.key === 'ArrowRight') cx += NUDGE_STEP; this.setElX(cx); this.setElY(cy); }
  onElementPointerDown(e) { this.selectedElement = e.currentTarget.dataset.el; e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); this.dragging = true; const canvas = this.template.querySelector('[data-canvas]'); if (!canvas) return; const rect = canvas.getBoundingClientRect(); const elRect = e.currentTarget.getBoundingClientRect(); this.pointerOffset.x = e.clientX - elRect.left; this.pointerOffset.y = e.clientY - elRect.top; this._boundOnMove = (ev) => { if (!this.dragging || this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = null; const xPx = (ev.clientX - rect.left) - this.pointerOffset.x; const yPx = (ev.clientY - rect.top) - this.pointerOffset.y; this.setElX((this.clampRaw(xPx, 0, rect.width) / rect.width) * SLIDE_W_IN); this.setElY((this.clampRaw(yPx, 0, rect.height) / rect.height) * SLIDE_H_IN); }); }; this._boundOnUp = () => { this.dragging = false; window.removeEventListener('pointermove', this._boundOnMove); window.removeEventListener('pointerup', this._boundOnUp); this._boundOnMove = null; this._boundOnUp = null; }; window.addEventListener('pointermove', this._boundOnMove); window.addEventListener('pointerup', this._boundOnUp); }
  setElX(x) { this.currentEl.x = this.clamp(x, 0, SLIDE_W_IN); this.registerChange(); } setElY(y) { this.currentEl.y = this.clamp(y, 0, SLIDE_H_IN); this.registerChange(); }

  async handleSave() { try { this.isSaving = true; this.errorMessage = ''; if (!this.templateName?.trim()) { this.errorMessage = 'Nombre obligatorio.'; return; } const payload = { theme: { primaryColor: this.colorPrimary, secondaryColor: this.colorSecondary, fontName: this.fontFamily }, slides: this.layout.slides }; const record = { sobjectType: 'Plantillas_Power_Point__c', Id: this.selectedTemplateId, Name: this.templateName.trim(), Activo__c: this.isActive, Color_Primario__c: this.colorPrimary, Color_Secundario__c: this.colorSecondary, Fuente_Corporativa__c: this.fontFamily, Configuracion_JSON__c: JSON.stringify(payload) }; await saveTemplate({ templateRecord: record }); await refreshApex(this.wiredTemplatesResult); this.isDirty = false; this.toast('Éxito', 'Plantilla guardada.', 'success'); } catch (e) { this.errorMessage = this.normalizeError(e); this.toast('Error', this.errorMessage, 'error'); } finally { this.isSaving = false; } }
  coerceLayout(cfgTxt) { let out = this.clone(DEFAULT_LAYOUT); let cfg; try { cfg = JSON.parse(cfgTxt); } catch { cfg = null; } if (cfg?.slides) { out.slides = { ...out.slides, ...cfg.slides }; ['portada','contenido','cierre'].forEach(s => { out.slides[s].title = { ...DEFAULT_LAYOUT.slides[s].title, ...(out.slides[s].title || {}) }; out.slides[s].subtitle = { ...DEFAULT_LAYOUT.slides[s].subtitle, ...(out.slides[s].subtitle || {}) }; if (s === 'contenido') out.slides[s].table = { ...DEFAULT_LAYOUT.slides[s].table, ...(out.slides[s].table || {}) }; }); } return out; }
  openCreateModal() { this.isCreateOpen = true; this.newTemplateName = ''; this.cloneFromId = ''; this.newActive = true; } closeCreateModal() { this.isCreateOpen = false; } handleNewName(e) { this.newTemplateName = e.detail.value; } handleCloneChange(e) { this.cloneFromId = e.detail.value; } handleNewActive(e) { this.newActive = e.target.checked; }
  async createTemplate() {
    try {
      const name = (this.newTemplateName || '').trim();
      if (!name) return this.toast('Error', 'Nombre obligatorio.', 'error');

      let prim = this.colorPrimary;
      let sec = this.colorSecondary;
      let font = this.fontFamily;
      let mergedLayout = this.clone(DEFAULT_LAYOUT);

      if (this.cloneFromId) {
        const src = this.templatesRaw?.find(t => t.Id === this.cloneFromId);
        if (src) {
          mergedLayout = this.coerceLayout(src.Configuracion_JSON__c);
          prim = src.Color_Primario__c || prim;
          sec = src.Color_Secundario__c || sec;
          font = src.Fuente_Corporativa__c || font;
        }
      }

      const payload = {
        theme: { primaryColor: prim, secondaryColor: sec, fontName: font },
        slides: mergedLayout.slides
      };

      const record = {
        sobjectType: 'Plantillas_Power_Point__c',
        Name: name,
        Activo__c: this.newActive,
        Color_Primario__c: prim,
        Color_Secundario__c: sec,
        Fuente_Corporativa__c: font,
        Configuracion_JSON__c: JSON.stringify(payload)
      };

      const newId = await saveTemplate({ templateRecord: record });
      await refreshApex(this.wiredTemplatesResult);
      this.isCreateOpen = false;
      this.toast('Éxito', 'Plantilla creada.', 'success');

      this.selectedTemplateId = newId;
      this.templateName = name.trim();
      this.colorPrimary = prim;
      this.colorSecondary = sec;
      this.fontFamily = font;
      this.isActive = this.newActive;
      this.layout = this.clone(mergedLayout);
      this.isDirty = false;
      this.errorMessage = '';
      this.activeSlide = 'portada';
      this.selectedElement = 'title';
      this.testPreviewText = '';
    } catch (e) {
      this.toast('Error', this.normalizeError(e), 'error');
    }
  }
  clone(obj) { return JSON.parse(JSON.stringify(obj)); } clampRaw(n, min, max) { return Math.min(max, Math.max(min, n)); } clamp(n, min, max) { return Number(Math.min(max, Math.max(min, n)).toFixed(2)); } toast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); } normalizeError(err) { return err?.body?.message || err?.message || 'Error'; }
  disconnectedCallback() { if (this._boundOnMove) window.removeEventListener('pointermove', this._boundOnMove); if (this._boundOnUp) window.removeEventListener('pointerup', this._boundOnUp); }
}