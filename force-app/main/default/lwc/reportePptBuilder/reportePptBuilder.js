import { LightningElement, api, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import { loadScript } from 'lightning/platformResourceLoader';
import PPTX_GEN from '@salesforce/resourceUrl/PptxGenJS';
import EXCEL_JS from '@salesforce/resourceUrl/exceljs';

import getPptDesigns from '@salesforce/apex/ReporteKaufmannController.getPptDesigns';
import getExcelFileBase64 from '@salesforce/apex/ReporteKaufmannController.getExcelFileBase64';
import getBase64Images from '@salesforce/apex/ReporteKaufmannController.getBase64Images';
import savePptConfigApex from '@salesforce/apex/ReporteKaufmannController.savePptConfig';
import getPptConfigApex from '@salesforce/apex/ReporteKaufmannController.getPptConfig';

const CHART_AGG_LABELS = { sum: 'Suma', count: 'Recuento', avg: 'Promedio', max: 'Máximo', min: 'Mínimo' };

/** Hex sin # para PptxGenJS y previews coherentes con plantilla */
const CHART_PALETTE_EXTRA = ['F59E0B', '10B981', '6366F1', 'EC4899', '14B8A6', 'F43F5E'];

/**
 * Auto-paginación de tablas PptxGenJS: la altura de línea estimada suele ser baja en celdas con mucho texto.
 * Sin compensación, la tabla “cree” que caben más filas de las que caben y el contenido se corta al borde.
 * Valores > 0 aumentan la altura estimada y disparan saltos de diapositiva antes (más conservador).
 */
const PPT_TABLE_AUTOPAGE_LINE_WEIGHT = 0.52;
const PPT_TABLE_AUTOPAGE_CHAR_WEIGHT = 0.12;

/** Márgenes de diapositiva (pulgadas T,R,B,L) solo para el cálculo interno de espacio útil del bloque tabla. */
const PPT_TABLE_SLIDE_MARGIN_IN = [0.25, 0.45, 0.65, 0.45];

/** Campos de gráfico copiados entre bloques / propagados */
const CHART_CLIP_KEYS = [
    'hasChart',
    'chartType',
    'chartAggregation',
    'chartShowLegend',
    'chartLegendPos',
    'chartShowValue',
    'chartSizePreset',
    'chartPosition',
    'chartTitle',
    'chartCategoryColumn',
    'chartValueColumn'
];

/** Formato guardado que admite varias presentaciones por el mismo Id de reporte. */
const PPT_CONFIG_VERSION = 2;
const PPT_LOCAL_BACKUP_KEY_PREFIX = 'pandora_ppt_backup_';

/** Auto-backup local mientras el usuario edita: cada N ms, si hubo cambios, guarda en sessionStorage. */
const AUTO_BACKUP_INTERVAL_MS = 30000;

/* Helpers de filtros avanzado importados (operadores: contiene, vacio, rango, etc).
   Wrapper conservador: si llaman con (cellValue, filterValue) primitivos, asume operador eq. */
import { matchesFilterAdvanced, isFilterUsable as isFilterUsableAdvanced, FILTER_OPERATORS, FILTER_OPERATOR_MAP, resolveFilterOperator } from './reportePptBuilderFilterUtils';

/** Wrapper retrocompatible: aplica el filtro completo (con operador) si recibe un objeto;
 *  o como eq simple si recibe valor primitivo. */
function applyBlockFilter(cellValue, filterOrValue) {
    if (filterOrValue && typeof filterOrValue === 'object') {
        return matchesFilterAdvanced(cellValue, filterOrValue);
    }
    return matchesFilterAdvanced(cellValue, { operator: 'eq', value: filterOrValue });
}

export default class ReportePptBuilder extends LightningElement {
    @api excelContentDocumentId;
    @api sheetName;
    @api reportId;
    /* Metadatos de la variante del reporte que generó el Excel base.
       Opcionales: si llegan, se muestran como contexto y se incorporan al filename .pptx.
       NO afectan a la persistencia: la config PPT sigue siendo por reportId. */
    @api reportVariantId;
    @api reportVariantName;

    /* Tooltip dinámico del chip de variante: nombre completo + aclaración de que el PPT se persiste por variante. */
    get reportVariantChipTooltip() {
        const name = this.reportVariantName || '';
        return `Variante activa del reporte: ${name}. La configuración de este PPT se guarda ligada a esta variante (no a otras).`;
    }

    /* P3: el thumbnail vacío de cada slide en la lista no aporta info útil (no es preview real).
       Lo ocultamos por defecto. Para reactivarlo se cambia este getter a true sin tocar el HTML. */
    get showSlideThumb() { return false; }
    get deckAccordionContainerClass() {
        return this.showSlideThumb
            ? 'accordion-container deck-accordion'
            : 'accordion-container deck-accordion deck-accordion--no-thumb';
    }

    @track designOptions = [];
    @track selectedDesign;
    @track includeCover = true;
    @track includeClosing = true;
    @track coverTitle = 'RESUMEN SERVICIO SOPORTE SAP VEHÍCULOS';
    @track coverDate = new Date().toISOString().split('T')[0];
    @track closingText = '¡Muchas Gracias!';
    
    @track slidesConfig = [];
    /** Listado de variantes de PPTX guardadas junto al reporte (mismo registro Apex). */
    @track pptPresentations = [];
    @track activePresentationId = null;
    /** Nombre editable de la variante activa (sincronizado al cambiar de combo). */
    @track presentationLabelDraft = '';
    @track lastLocalBackupAt = null;
    /** Firma de la config tal como está guardada en servidor; sirve para detectar 'cambios sin guardar'. */
    @track _savedConfigSignature = '';
    /** Indice de la slide siendo arrastrada (drag&drop). null cuando no hay drag en curso. */
    _dragSrcSlideIdx = null;
    /** Stack para Undo (estados anteriores en JSON). @track para reactividad de undoDisabled. */
    @track _undoStack = [];
    /** Stack para Redo (estados deshechos en JSON). @track para reactividad de redoDisabled. */
    @track _redoStack = [];
    /** Ultimo snapshot JSON conocido del estado actual. */
    _lastSnapshotJson = '';
    /** Tope maximo de snapshots para no inflar memoria. */
    UNDO_STACK_MAX = 20;
    /** Panel lateral de variantes PPTX expandido (por defecto plegado). */
    @track showPresentationVariantsExpanded = false;
    @track activeSections = [];
    @track isParsingExcel = true;
    @track parsingStatusText = 'Extrayendo datos y estilos del Excel...';
    @track currentTemplateColors = { primary: '#263B7A', secondary: '#64748b', font: 'Calibri' };
    @track sheetOptions = [];
    
    @track isColumnsModalOpen = false;
    @track columnsSearch = '';
    @track modalSelectedColumns = [];

    @track isExporting = false;
    @track exportProgress = 0;
    @track exportStatusText = 'Preparando entorno...';
    
    @track showPreviewModal = false;
    @track previewSlidesArray = [];
    
    bgImages = { portada: null, contenido: null, cierre: null };

    designRecords = [];
    parsedExcelData = {};
    allModalOptions = [];
    columnsModalRef = null; 

    pptxLoaded = false;
    excelLoaded = false;
    libsLoading = false;

    /** Portapapeles interno: opciones de gráfico copiadas desde un bloque */
    @track chartClipboardPayload = null;

    /* Filtro visual del listado de diapositivas (no afecta exportación, solo qué vemos). */
    @track _slidesFilterMode = 'all';

    /* Pie de slide con conteo de registros en el PPT exportado.
       - showRecordCountFooter: si true, añade una línea pequeña al final de cada slide
         con bloques. Por defecto OFF para no cambiar PPTs ya generados.
       - recordCountPosition: 'top-right' | 'bottom-right' | 'bottom-left' | 'bottom-center'.
       Persistidos junto al resto del config dentro de cada variante PPT. */
    @track showRecordCountFooter = false;
    @track recordCountPosition = 'bottom-right';

    /* Conteo de registros junto al título de la slide.
       Si true (default), al título del slide se le añade " (N)" donde N es el total
       de filas filtradas en los bloques tipo tabla/chart de esa slide. Ejemplo:
       "Tickets abiertos con SLA vencido (4)". No suma pivots porque su agregación
       no es comparable a "registros".  */
    @track showRecordCountInTitle = true;

    /* Numeración de páginas cuando una tabla se divide en varias slides.
       Si true (default), se muestra "Pag X / N" en la esquina inferior derecha
       de cada slide que pertenece a una tabla dividida. La división puede ser:
         - Horizontal (split de columnas con respectOriginalWidths).
         - Vertical (paginación manual por filas).
       Activar este toggle también activa la paginación manual por filas en
       reemplazo del autoPage de pptxgenjs, porque sólo así sabemos cuántas
       páginas habrá (autoPage no expone esa info y no podemos numerar). */
    @track showPageNumbers = true;

    /* Formato de fecha aplicado a TODAS las celdas Date del PPT (preview + exportación).
       Se mantiene en estado y se persiste en el config. Al cambiarlo, reformateamos in-place
       las celdas usando los Date originales guardados en parsedExcelData[sheet]._dateOriginals. */
    @track pptDateFormat = 'ddmmyyyy_slash';

    get pptDateFormatOptions() {
        return [
            { label: 'DD/MM/YYYY  (26/05/2026)', value: 'ddmmyyyy_slash' },
            { label: 'DD-MM-YYYY  (26-05-2026)', value: 'ddmmyyyy_dash' },
            { label: 'YYYY-MM-DD  (2026-05-26)', value: 'yyyymmdd_dash' },
            { label: 'MM/DD/YYYY  (05/26/2026)', value: 'mmddyyyy_slash' },
            { label: 'DD mmm YYYY  (26 may 2026)', value: 'long_es' }
        ];
    }

    /* Intenta parsear un string a Date SOLO si el formato es inequívoco (ISO o con
       año al inicio: YYYY-MM-DD, YYYY/MM/DD, YYYY-MM-DDTHH:mm[:ss[.sss[Z]]], etc.).
       Es CRÍTICO no parsear strings ambiguos como "1/2/2026" porque no sabemos si
       es DD/MM o MM/DD; en ese caso devolvemos null y dejamos el string como vino.
       Esto cubre el caso real: Salesforce Reports API entrega las columnas de fecha
       como strings ya formateados en ISO (YYYY-MM-DD), no como Date instances, así
       que el parser de ExcelJS las ve como `cell.value` string y la rama Date no
       se dispara. Detectándolas aquí podemos reformatearlas según pptDateFormat.
       Devuelve Date válido o null. */
    tryParseUnambiguousDate(str) {
        if (typeof str !== 'string') return null;
        const s = str.trim();
        if (s.length < 8 || s.length > 35) return null;
        /* Bloqueamos explícitamente strings que ya parecen DMY o MDY con separador /
           o - y año de 4 dígitos al final, porque son ambiguos. */
        if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(s)) return null;
        /* Aceptamos solo patrones con año al inicio (4 dígitos), que son inequívocos:
           YYYY-MM-DD | YYYY/MM/DD | YYYY-MM-DD HH:mm[:ss] | YYYY-MM-DDTHH:mm:ss[.sss[Z|±HH:MM]] */
        const isoLike = /^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+\-]\d{2}:?\d{2})?)?$/;
        const m = s.match(isoLike);
        if (!m) return null;
        const yyyy = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const dd = parseInt(m[3], 10);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900 || yyyy > 2999) return null;
        const hh = m[4] != null ? parseInt(m[4], 10) : 0;
        const mi = m[5] != null ? parseInt(m[5], 10) : 0;
        const ss = m[6] != null ? parseInt(m[6], 10) : 0;
        /* Constructor local (no toISOString) para evitar saltos por zona horaria que
           desplacen el día visible respecto al string original. */
        const d = new Date(yyyy, mm - 1, dd, hh, mi, ss);
        if (isNaN(d.getTime())) return null;
        return d;
    }

    /* Convierte un Date al formato configurado. Devuelve '' si el Date es inválido. */
    formatDateAsMode(dateObj, mode) {
        if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) return '';
        const dd = String(dateObj.getDate()).padStart(2, '0');
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const yyyy = dateObj.getFullYear();
        const mShort = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        switch (mode) {
            case 'ddmmyyyy_dash':  return `${dd}-${mm}-${yyyy}`;
            case 'yyyymmdd_dash':  return `${yyyy}-${mm}-${dd}`;
            case 'mmddyyyy_slash': return `${mm}/${dd}/${yyyy}`;
            case 'long_es':        return `${dd} ${mShort[dateObj.getMonth()]} ${yyyy}`;
            case 'ddmmyyyy_slash':
            default:               return `${dd}/${mm}/${yyyy}`;
        }
    }

    handleDateFormatChange(event) {
        const v = (event && event.detail && event.detail.value) || (event && event.target && event.target.value);
        if (!v || v === this.pptDateFormat) return;
        this.pptDateFormat = v;
        this.reformatAllDates();
    }

    /* Recorre todas las hojas parseadas y reformatea las celdas que originalmente eran Date,
       usando los Date instances que guardamos en `_dateOriginals`. Después refresca los
       previews para reflejar el cambio en la UI. Importante: NO requiere recargar el Excel. */
    reformatAllDates() {
        if (!this.parsedExcelData) return;
        Object.keys(this.parsedExcelData).forEach((sheetName) => {
            const sheet = this.parsedExcelData[sheetName];
            const originals = sheet && sheet._dateOriginals;
            if (!Array.isArray(originals) || !Array.isArray(sheet.rows)) return;
            originals.forEach((rowMap, idx) => {
                if (!rowMap || !sheet.rows[idx]) return;
                Object.keys(rowMap).forEach((colName) => {
                    const d = rowMap[colName];
                    if (d instanceof Date && !isNaN(d.getTime())) {
                        sheet.rows[idx][colName] = this.formatDateAsMode(d, this.pptDateFormat);
                    }
                });
            });
        });
        this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
    }

    get recordCountPositionOptions() {
        return [
            { label: 'Esquina superior derecha', value: 'top-right' },
            { label: 'Esquina inferior derecha', value: 'bottom-right' },
            { label: 'Esquina inferior izquierda', value: 'bottom-left' },
            { label: 'Centro inferior', value: 'bottom-center' }
        ];
    }

    handleRecordCountToggle(event) {
        this.showRecordCountFooter = !!(event.detail && event.detail.checked);
    }

    handleRecordCountPositionChange(event) {
        const v = (event.detail && event.detail.value) || (event.target && event.target.value);
        if (v) this.recordCountPosition = v;
    }

    handleRecordCountInTitleToggle(event) {
        this.showRecordCountInTitle = !!(event.detail && event.detail.checked);
    }

    handlePageNumbersToggle(event) {
        this.showPageNumbers = !!(event.detail && event.detail.checked);
    }

    get slidesFilterOptions() {
        return [
            { label: 'Filtro: Todas', value: 'all' },
            { label: 'Filtro: Incluidas', value: 'included' },
            { label: 'Filtro: Excluidas', value: 'excluded' },
            { label: 'Filtro: Con alertas', value: 'issues' }
        ];
    }

    get slidesFilterMode() { return this._slidesFilterMode || 'all'; }

    handleSlidesFilterChange(event) {
        const next = (event && event.detail && event.detail.value) || (event && event.target && event.target.value) || 'all';
        this._slidesFilterMode = next;
    }

    /* Conteo de slides con alertas (sin importar si están incluidas/excluidas).
       Reusa computeSlideExportHints igual que slidesForAccordion. */
    get slidesWithIssuesCount() {
        return (this.slidesConfig || []).reduce((acc, s) => {
            const diag = this.computeSlideExportHints(s);
            return acc + (diag.issues.length > 0 ? 1 : 0);
        }, 0);
    }

    /* Etiqueta dinámica del chip filtro (UI). */
    get slidesFilterLabel() {
        const map = {
            all: 'Filtro: Todas',
            included: 'Filtro: Incluidas',
            excluded: 'Filtro: Excluidas',
            issues: 'Filtro: Con alertas'
        };
        return map[this.slidesFilterMode] || 'Filtro: Todas';
    }

    /* Aviso visible si el filtro activo oculta diapositivas (transparencia para el usuario). */
    get slidesFilterHidesAny() {
        const total = (this.slidesConfig || []).length;
        const visible = (this.slidesForAccordion || []).length;
        return this.slidesFilterMode !== 'all' && visible < total;
    }

    get slidesFilterHiddenCount() {
        return Math.max(0, (this.slidesConfig || []).length - (this.slidesForAccordion || []).length);
    }

    get chartOptions() {
        return [
            { label: 'Barras (Bar)', value: 'bar' },
            { label: 'Anillo (Doughnut)', value: 'doughnut' },
            { label: 'Líneas (Line)', value: 'line' },
            { label: 'Circular (Pie)', value: 'pie' }
        ];
    }

    get chartAggregationOptions() {
        return [
            { label: 'Suma', value: 'sum' },
            { label: 'Recuento de filas', value: 'count' },
            { label: 'Promedio (solo números)', value: 'avg' },
            { label: 'Máximo', value: 'max' },
            { label: 'Mínimo', value: 'min' }
        ];
    }

    get chartLegendPosOptions() {
        return [
            { label: 'Abajo', value: 'b' },
            { label: 'Arriba', value: 't' },
            { label: 'Izquierda', value: 'l' },
            { label: 'Derecha', value: 'r' }
        ];
    }

    get chartSizePresetOptions() {
        return [
            { label: 'Pequeño', value: 'small' },
            { label: 'Mediano', value: 'medium' },
            { label: 'Grande', value: 'large' }
        ];
    }

    get chartPositionOptions() {
        return [
            { label: 'Solo gráfico (sin tabla en el bloque)', value: 'solo' },
            { label: 'A la derecha de la tabla', value: 'right' },
            { label: 'Debajo de la tabla', value: 'below' }
        ];
    }

    get pivotAggregationOptions() {
        return this.chartAggregationOptions;
    }

    get pivotOrientationOptions() {
        return [
            { label: 'Vertical (filas)', value: 'vertical' },
            { label: 'Horizontal (cabeceras = categorías)', value: 'horizontal' }
        ];
    }

    get pivotCategorySortOptions() {
        return [
            { label: 'Orden del Excel (aparición)', value: 'appearance' },
            { label: 'Categoría A → Z', value: 'alpha' },
            { label: 'Categoría Z → A', value: 'alpha_desc' },
            { label: 'Valor: mayor primero', value: 'value_desc' },
            { label: 'Valor: menor primero', value: 'value_asc' }
        ];
    }

    get presentationOptions() {
        return (this.pptPresentations || []).map((p) => ({ label: p.label || 'Sin nombre', value: p.id }));
    }

    get canRemovePresentation() {
        return (this.pptPresentations || []).length > 1;
    }

    get removePresentationDisabled() {
        return !this.canRemovePresentation;
    }

    get restoreLocalBackupDisabled() {
        return this.isGenerateDisabled || !this.hasLocalBackup;
    }

    get localBackupKey() {
        const rid = (this.reportId || 'unknown').toString();
        /* PPT por variante: la key incluye la variante para aislar respaldos.
           Si no llega reportVariantId, se usa 'default' (compatible con el flujo legacy). */
        const vid = (this.reportVariantId || 'default').toString();
        return `${PPT_LOCAL_BACKUP_KEY_PREFIX}${rid}__${vid}`;
    }

    get hasLocalBackup() {
        if (!this.reportId) return false;
        try {
            return !!sessionStorage.getItem(this.localBackupKey);
        } catch (_e) {
            return false;
        }
    }

    get localBackupLabel() {
        if (!this.lastLocalBackupAt) return 'Respaldo local';
        try {
            return `Respaldo local (${new Date(this.lastLocalBackupAt).toLocaleString('es-CL')})`;
        } catch (_e) {
            return 'Respaldo local';
        }
    }

    /**
     * Indica si la configuración en memoria difiere de la última versión guardada
     * (servidor o importada). Se basa en la firma rápida que ya usa el auto-backup.
     */
    get hasUnsavedChanges() {
        if (!this.reportId) return false;
        try {
            const current = this._computeBackupSignature();
            if (!this._savedConfigSignature) return !!current;
            return current !== this._savedConfigSignature;
        } catch (_e) {
            return false;
        }
    }

    get filterOperatorOptions() {
        return FILTER_OPERATORS.map((op) => ({ label: op.label, value: op.value }));
    }

    get unsavedBadgeClass() {
        return this.hasUnsavedChanges
            ? 'unsaved-badge unsaved-badge--dirty'
            : 'unsaved-badge unsaved-badge--clean';
    }

    get unsavedBadgeLabel() {
        return this.hasUnsavedChanges ? '● Cambios sin guardar' : '✓ Sincronizado';
    }

    get unsavedBadgeTitle() {
        return this.hasUnsavedChanges
            ? 'Hay cambios en memoria que aún no se guardaron en Salesforce. Usa "Guardar diseño" para persistirlos.'
            : 'La configuración en memoria coincide con la última versión guardada.';
    }

    togglePresentationVariantsPanel() {
        this.showPresentationVariantsExpanded = !this.showPresentationVariantsExpanded;
    }

    /* Dispatcher del menú "Más" del header. Mantiene los handlers individuales
       (restoreFromLocalBackup / exportConfigToFile / triggerImportFileDialog) intactos. */
    handleHeaderMoreMenuSelect(event) {
        const value = event && event.detail && event.detail.value;
        if (!value) return;
        if (value === 'backup') { this.restoreFromLocalBackup(); return; }
        if (value === 'export-json') { this.exportConfigToFile(); return; }
        if (value === 'import-json') { this.triggerImportFileDialog(); return; }
    }

    get presentationVariantSummary() {
        const total = (this.pptPresentations || []).length;
        const active = (this.pptPresentations || []).find((p) => p.id === this.activePresentationId);
        const name = (active && active.label) || this.presentationLabelDraft || '—';
        return `${total} variante${total !== 1 ? 's' : ''} PPT · «${name}»`;
    }

    get presentationVariantsToggleLabel() {
        return this.showPresentationVariantsExpanded ? 'Ocultar' : 'Variantes PPT';
    }

    /** Texto casi invisible para el toggle del acordeón: evita las etiquetas Sí / No por debajo del control. */
    get slideExportToggleMessageBlank() {
        return '\u200b';
    }

    async confirmDeletion(message, label) {
        return LightningConfirm.open({
            message,
            variant: 'header',
            label: label || 'Confirmar acción',
            theme: 'warning'
        });
    }

    /**
     * Elimina sólo datos de vista previa y listas duplicadas de columnas antes de persistir —
     * el JSON puede superar el límite de Long Text (~131 KB) si se guardan 20 slides con esas colecciones.
     */
    sanitizeTableForPersist(tb) {
        if (!tb || typeof tb !== 'object') return tb;
        const drop = [
            'chartPreviewModel',
            'previewHeaders',
            'previewRows',
            'previewHeaderCells',
            'pivotGroupOptions',
            'pivotValueOptions',
            'chartCategoryOptions',
            'chartValueOptions',
            'configBoxClass',
            'flagPivotBlock',
            'isPivotBlock',
            'pivotMeasureDisabled',
            'chartSolo',
            'columnOptions',
            'selectedColumnOrderHints'
        ];
        drop.forEach((k) => { delete tb[k]; });
        if (Array.isArray(tb.filters)) {
            tb.filters = tb.filters.map((f) => {
                if (!f || typeof f !== 'object') return f;
                const fo = { ...f };
                delete fo.valueOptions;
                delete fo.disableVal;
                return fo;
            });
        }
        return tb;
    }

    sanitizeSlidesForPersist(slides) {
        const copies = JSON.parse(JSON.stringify(slides || []));
        copies.forEach((slide) => {
            slide.tables = (slide.tables || []).map((t) => this.sanitizeTableForPersist(t));
        });
        return copies;
    }

    persistActivePresentationSlides() {
        if (!this.activePresentationId || !this.pptPresentations?.length) return;
        const slidesCopy = this.sanitizeSlidesForPersist(this.slidesConfig || []);
        this.pptPresentations = this.pptPresentations.map((p) =>
            p.id === this.activePresentationId ? { ...p, slidesConfig: slidesCopy } : p
        );
    }

    ensurePresentationEnvelopeSeeded() {
        if (this.pptPresentations?.length) {
            if (!this.activePresentationId) {
                this.activePresentationId = this.pptPresentations[0].id;
            }
            return;
        }
        const id = `pres_${Date.now()}`;
        this.pptPresentations = [{ id, label: 'Principal', slidesConfig: this.sanitizeSlidesForPersist(this.slidesConfig || []) }];
        this.activePresentationId = id;
    }

    syncPresentationLabelDraft() {
        const p = (this.pptPresentations || []).find((x) => x.id === this.activePresentationId);
        this.presentationLabelDraft = p?.label ?? '';
    }

    buildPersistablePptConfig() {
        this.persistActivePresentationSlides();
        const presentationsOut = this.pptPresentations.map((p) => ({
            id: p.id,
            label: p.label || 'Sin nombre',
            slidesConfig: this.sanitizeSlidesForPersist(
                p.id === this.activePresentationId ? this.slidesConfig || [] : p.slidesConfig || []
            )
        }));
        return {
            pptConfigVersion: PPT_CONFIG_VERSION,
            selectedDesign: this.selectedDesign,
            includeCover: this.includeCover,
            includeClosing: this.includeClosing,
            coverTitle: this.coverTitle,
            coverDate: this.coverDate,
            closingText: this.closingText,
            showRecordCountFooter: this.showRecordCountFooter,
            recordCountPosition: this.recordCountPosition,
            showRecordCountInTitle: this.showRecordCountInTitle,
            showPageNumbers: this.showPageNumbers,
            pptDateFormat: this.pptDateFormat,
            activePresentationId: this.activePresentationId,
            presentations: presentationsOut
        };
    }

    saveLocalBackupSnapshot(reason = 'manual') {
        if (!this.reportId) return;
        try {
            const cfg = this.buildPersistablePptConfig();
            const payload = { savedAt: new Date().toISOString(), reason, config: cfg };
            sessionStorage.setItem(this.localBackupKey, JSON.stringify(payload));
            this.lastLocalBackupAt = payload.savedAt;
        } catch (e) {
            console.warn('No se pudo guardar respaldo local de PPT', e);
        }
    }

    applyLoadedPptConfig(config) {
        if (!config || typeof config !== 'object') return false;
        if (config.selectedDesign) this.selectedDesign = config.selectedDesign;
        if (config.includeCover !== undefined) this.includeCover = config.includeCover;
        if (config.includeClosing !== undefined) this.includeClosing = config.includeClosing;
        if (config.coverTitle) this.coverTitle = config.coverTitle;
        if (config.coverDate) this.coverDate = config.coverDate;
        if (config.closingText) this.closingText = config.closingText;
        /* Settings de conteo de registros (backward compat: si el config legacy
           no los trae, dejamos los defaults del componente, que son OFF). */
        if (config.showRecordCountFooter !== undefined) this.showRecordCountFooter = !!config.showRecordCountFooter;
        if (typeof config.recordCountPosition === 'string' && config.recordCountPosition) {
            this.recordCountPosition = config.recordCountPosition;
        }
        /* Settings nuevos de conteo en el título y numeración de páginas.
           Backward compat: configs antiguos no los tienen, dejamos los defaults
           (ambos ON). Esto no rompe PPTs ya generados porque los toggles solo
           afectan la PRÓXIMA generación. */
        if (config.showRecordCountInTitle !== undefined) this.showRecordCountInTitle = !!config.showRecordCountInTitle;
        if (config.showPageNumbers !== undefined) this.showPageNumbers = !!config.showPageNumbers;
        /* Formato global de fechas. Backward compat: si el config legacy no lo trae,
           se mantiene el default ('ddmmyyyy_slash'). */
        if (typeof config.pptDateFormat === 'string' && config.pptDateFormat) {
            this.pptDateFormat = config.pptDateFormat;
        }

        let slidesSource = [];
        if (config.pptConfigVersion >= 2 && Array.isArray(config.presentations) && config.presentations.length) {
            this.pptPresentations = config.presentations.map((p) => ({
                id: p.id || `pres_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                label: p.label || 'Sin nombre',
                slidesConfig: Array.isArray(p.slidesConfig) ? p.slidesConfig : []
            }));
            this.activePresentationId = config.activePresentationId || this.pptPresentations[0].id;
            let active = this.pptPresentations.find((p) => p.id === this.activePresentationId);
            if (!active) {
                active = this.pptPresentations[0];
                this.activePresentationId = active.id;
            }
            slidesSource = active.slidesConfig || [];
        } else {
            slidesSource = config.slidesConfig || [];
            this.pptPresentations = [{
                id: 'pres_principal',
                label: 'Principal',
                slidesConfig: JSON.parse(JSON.stringify(slidesSource))
            }];
            this.activePresentationId = 'pres_principal';
        }

        if (slidesSource.length > 0) {
            this.slidesConfig = this.hydrateTablesInSlides(slidesSource);
            this.activeSections = [];
        } else {
            this.slidesConfig = [];
        }
        this.syncPresentationLabelDraft();
        /* Si ya hay datos parseados cuando se aplica un config (p.ej. al cambiar de
           variante PPT con Excel ya cargado), reformateamos fechas para que el formato
           recién cargado se vea reflejado en las celdas. */
        if (this.parsedExcelData && Object.keys(this.parsedExcelData).length) {
            this.reformatAllDates();
        }
        return true;
    }

    async restoreFromLocalBackup() {
        if (!this.hasLocalBackup) {
            this.showToast('Aviso', 'No existe respaldo local para este reporte.', 'info');
            return;
        }
        try {
            const raw = sessionStorage.getItem(this.localBackupKey);
            const payload = JSON.parse(raw);
            const ok = this.applyLoadedPptConfig(payload?.config || null);
            if (!ok) {
                this.showToast('Aviso', 'El respaldo local no contiene una configuración válida.', 'warning');
                return;
            }
            this.lastLocalBackupAt = payload?.savedAt || null;
            this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
            await this.updatePreviewColors();
            this.showToast('Restaurado', 'Se aplicó el respaldo local de la configuración.', 'success');
        } catch (e) {
            console.error('Error restaurando respaldo local PPT', e);
            this.showToast('Error', 'No se pudo restaurar el respaldo local.', 'error');
        }
    }

    connectedCallback() {
        this._lastBackupSignature = '';
        this._savedConfigSignature = '';
        this._undoStack = [];
        this._redoStack = [];
        this._lastSnapshotJson = '';
        this._autoBackupTimer = setInterval(() => this._autoBackupTick(), AUTO_BACKUP_INTERVAL_MS);
        this._boundEscapeHandler = this._handleEscapeKey.bind(this);
        this._boundUndoRedoHandler = this._handleUndoRedoKey.bind(this);
        window.addEventListener('keydown', this._boundEscapeHandler);
        window.addEventListener('keydown', this._boundUndoRedoHandler);
    }

    disconnectedCallback() {
        if (this._autoBackupTimer) {
            clearInterval(this._autoBackupTimer);
            this._autoBackupTimer = null;
        }
        if (this._boundEscapeHandler) {
            window.removeEventListener('keydown', this._boundEscapeHandler);
            this._boundEscapeHandler = null;
        }
        if (this._boundUndoRedoHandler) {
            window.removeEventListener('keydown', this._boundUndoRedoHandler);
            this._boundUndoRedoHandler = null;
        }
    }

    /** Cierra el modal abierto cuando se pulsa Escape. */
    _handleEscapeKey(event) {
        if (event.key !== 'Escape') return;
        if (this.isColumnsModalOpen) { event.preventDefault(); this.closeColumnsModal(); return; }
        if (this.showPreviewModal) { event.preventDefault(); this.closePreviewModal(); return; }
    }

    /**
     * Tick periódico: si la configuración cambió desde el último backup automático,
     * persiste un snapshot en sessionStorage. Protege ante cierre de pestaña sin "Guardar diseño".
     */
    _autoBackupTick() {
        if (!this.reportId) return;
        if (this.isExporting || this.isParsingExcel) return;
        try {
            const sig = this._computeBackupSignature();
            if (!sig || sig === this._lastBackupSignature) return;
            this.saveLocalBackupSnapshot('auto');
            this._lastBackupSignature = sig;
            /* Tambien capturamos un punto de undo aqui por si la accion no llamo a captureUndoSnapshot. */
            this._captureUndoSnapshot();
        } catch (e) {
            console.warn('Auto-backup tick falló', e);
        }
    }

    /* === Undo / Redo ===
       Cada vez que el usuario realiza una accion destructiva o significativa, registramos
       el snapshot ANTERIOR (_lastSnapshotJson) en _undoStack y descartamos _redoStack.
       Limitamos a UNDO_STACK_MAX entradas. */
    _serializeStateForUndo() {
        try {
            return JSON.stringify(this.buildPersistablePptConfig());
        } catch (e) {
            console.warn('No se pudo serializar estado para undo', e);
            return '';
        }
    }

    _captureUndoSnapshot() {
        const current = this._serializeStateForUndo();
        if (!current) return;
        if (this._lastSnapshotJson && current !== this._lastSnapshotJson) {
            const next = [...this._undoStack, this._lastSnapshotJson];
            this._undoStack = next.length > this.UNDO_STACK_MAX ? next.slice(next.length - this.UNDO_STACK_MAX) : next;
            /* Cualquier nueva accion invalida el historial de redo. */
            this._redoStack = [];
        }
        this._lastSnapshotJson = current;
    }

    /** Inicializa el estado base de undo (llamar despues de cargar/preparar la config inicial). */
    _resetUndoBaseline() {
        this._undoStack = [];
        this._redoStack = [];
        this._lastSnapshotJson = this._serializeStateForUndo();
    }

    async _applyUndoSnapshot(json) {
        if (!json) return;
        try {
            const parsed = JSON.parse(json);
            const ok = this.applyLoadedPptConfig(parsed);
            if (!ok) return;
            this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
            await this.updatePreviewColors();
            this._lastSnapshotJson = json;
            this._lastBackupSignature = this._computeBackupSignature();
        } catch (e) {
            console.error('Error aplicando snapshot undo/redo', e);
            this.showToast('Error', 'No se pudo aplicar el cambio de historial.', 'error');
        }
    }

    async _undoLastChange() {
        if (!this._undoStack.length) {
            this.showToast('Sin cambios', 'No hay nada que deshacer.', 'info');
            return;
        }
        const newUndo = [...this._undoStack];
        const prev = newUndo.pop();
        const current = this._lastSnapshotJson || this._serializeStateForUndo();
        let newRedo = this._redoStack;
        if (current) {
            newRedo = [...this._redoStack, current];
            if (newRedo.length > this.UNDO_STACK_MAX) newRedo = newRedo.slice(newRedo.length - this.UNDO_STACK_MAX);
        }
        this._undoStack = newUndo;
        this._redoStack = newRedo;
        await this._applyUndoSnapshot(prev);
        this.showToast('Deshecho', `Volviendo al estado anterior (${this._undoStack.length} pasos previos).`, 'info');
    }

    async _redoLastChange() {
        if (!this._redoStack.length) {
            this.showToast('Sin cambios', 'No hay nada que rehacer.', 'info');
            return;
        }
        const newRedo = [...this._redoStack];
        const next = newRedo.pop();
        const current = this._lastSnapshotJson || this._serializeStateForUndo();
        let newUndo = this._undoStack;
        if (current) {
            newUndo = [...this._undoStack, current];
            if (newUndo.length > this.UNDO_STACK_MAX) newUndo = newUndo.slice(newUndo.length - this.UNDO_STACK_MAX);
        }
        this._redoStack = newRedo;
        this._undoStack = newUndo;
        await this._applyUndoSnapshot(next);
        this.showToast('Rehecho', 'Restauraste el cambio.', 'info');
    }

    handleUndoClick() { this._undoLastChange(); }
    handleRedoClick() { this._redoLastChange(); }
    get undoDisabled() { return !(this._undoStack && this._undoStack.length); }
    get redoDisabled() { return !(this._redoStack && this._redoStack.length); }

    _handleUndoRedoKey(event) {
        if (!event.ctrlKey && !event.metaKey) return;
        const k = (event.key || '').toLowerCase();
        const isInputTarget = (() => {
            const t = event.target;
            if (!t) return false;
            const tag = (t.tagName || '').toUpperCase();
            return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
        })();
        if (isInputTarget) return; /* Permite Ctrl+Z dentro de inputs para edicion de texto. */
        if (k === 'z' && !event.shiftKey) {
            event.preventDefault();
            this._undoLastChange();
        } else if ((k === 'z' && event.shiftKey) || k === 'y') {
            event.preventDefault();
            this._redoLastChange();
        }
    }

    /** Firma rápida que detecta cambios significativos sin serializar todo cada vez. */
    _computeBackupSignature() {
        try {
            const slidesPart = (this.slidesConfig || []).map(s => `${s.id}|${s.title || ''}|${s.subtitle || ''}|${s.excludeFromExport ? 1 : 0}|${(s.tables || []).length}|${(s.speakerNotes || '').length}|${(s.logoBase64 || '').length}|${s.logoCorner || ''}|${s.logoSizePct || ''}`).join('~');
            return [
                this.selectedDesign || '',
                this.includeCover ? '1' : '0',
                this.includeClosing ? '1' : '0',
                this.coverTitle || '',
                this.coverDate || '',
                this.closingText || '',
                this.activePresentationId || '',
                (this.pptPresentations || []).length,
                slidesPart.length,
                slidesPart
            ].join('::');
        } catch (e) {
            return '';
        }
    }

    /* ───── Exportar / Importar configuración como archivo JSON ───── */

    exportConfigToFile() {
        try {
            const config = this.buildPersistablePptConfig();
            const wrapper = {
                _meta: {
                    exportedAt: new Date().toISOString(),
                    source: 'reportePptBuilder',
                    reportId: this.reportId || null
                },
                config
            };
            const blob = new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const label = (this.pptPresentations.find(p => p.id === this.activePresentationId)?.label || 'config').replace(/[^a-zA-Z0-9_-]/g, '_');
            a.href = url;
            a.download = `ppt_config_${label}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.showToast('Exportado', 'Se descargó el archivo de configuración.', 'success');
        } catch (e) {
            console.error('Error exportando configuración PPT', e);
            this.showToast('Error', 'No se pudo exportar la configuración.', 'error');
        }
    }

    triggerImportFileDialog() {
        const input = this.template.querySelector('input[data-id="import-config-file"]');
        if (input) input.click();
    }

    async handleImportConfigFile(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (!file.name.endsWith('.json')) {
            this.showToast('Aviso', 'Selecciona un archivo .json válido.', 'warning');
            return;
        }
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const config = parsed?.config || parsed;
            if (!config || typeof config !== 'object') {
                this.showToast('Aviso', 'El archivo no contiene una configuración válida.', 'warning');
                return;
            }
            /* Validación cruzada: rechazar archivos que claramente son del reporteKaufmann (no del PPT).
               Mira tanto la marca _meta.source como la "huella" estructural (config.sheets con columns
               pero sin slidesConfig). Damos un mensaje claro de dónde debe ir ese archivo. */
            const source = parsed && parsed._meta && parsed._meta.source;
            const looksLikeReportConfig = Array.isArray(config.sheets)
                && config.sheets.length > 0
                && Array.isArray(config.sheets[0].columns)
                && !Array.isArray(config.slidesConfig);
            if (source === 'reporteKaufmann' || (source !== 'reportePptBuilder' && looksLikeReportConfig)) {
                this.showToast(
                    'Archivo del componente incorrecto',
                    'Este archivo es la configuración del REPORTE Kaufmann, no del PPT. Llévalo al gestor de Variantes del reporte («Variantes» → «Importar archivo .json como variante»).',
                    'warning',
                    'sticky'
                );
                return;
            }
            const confirmed = await LightningConfirm.open({
                message: 'Esto reemplazará la configuración actual con la del archivo importado. ¿Deseas continuar?',
                label: 'Importar configuración',
                theme: 'warning'
            });
            if (!confirmed) return;
            this.saveLocalBackupSnapshot('before_import');
            const ok = this.applyLoadedPptConfig(config);
            if (!ok) {
                this.showToast('Aviso', 'La configuración del archivo no pudo aplicarse.', 'warning');
                return;
            }
            this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
            await this.updatePreviewColors();
            /* Reset baseline para que el undo no salte hacia atras del import. */
            this._resetUndoBaseline();
            this.showToast('Importado', 'Se aplicó la configuración del archivo. Usa «Guardar diseño» para persistirla en Salesforce.', 'success');
        } catch (e) {
            console.error('Error importando configuración PPT', e);
            this.showToast('Error', 'No se pudo leer o aplicar el archivo de configuración.', 'error');
        }
    }

    /**
     * Restaura desplegables de filtros desde el Excel (no se guardan en SF para aligerar el JSON).
     */
    rehydrateTableFilterOptions(table, sheetData) {
        if (!sheetData || !Array.isArray(table.filters) || !table.filters.length) return;
        const allCols = (sheetData.allColumns || []).map((c) => c.value);
        const sameVal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
        table.filters = table.filters.map((f) => {
            const filter = { ...f };
            const col = filter.column;
            if (!col || col === 'TODOS') {
                filter.value = 'TODOS';
                filter.valueOptions = [{ label: 'Todos', value: 'TODOS' }];
                filter.disableVal = true;
            } else {
                if (!allCols.includes(col)) {
                    // No destruir filtros históricos aunque cambie el set de columnas en el Excel actual.
                    filter.valueOptions = [{ label: 'Todos', value: 'TODOS' }];
                    if (!sameVal(filter.value, 'TODOS') && String(filter.value || '').trim() !== '') {
                        filter.valueOptions.push({ label: `${String(filter.value)} (valor previo)`, value: filter.value });
                    }
                    filter.disableVal = false;
                    return filter;
                }
                const uniqueVals = new Set();
                sheetData.rows.forEach((r) => {
                    if (r[col] !== undefined && r[col] !== null && r[col] !== '') uniqueVals.add(r[col]);
                });
                filter.valueOptions = [{ label: 'Todos', value: 'TODOS' }];
                Array.from(uniqueVals).sort().forEach((v) => filter.valueOptions.push({ label: String(v), value: v }));
                filter.disableVal = false;
                const ok = filter.valueOptions.some((o) => sameVal(o.value, filter.value));
                if (!ok && !sameVal(filter.value, 'TODOS') && String(filter.value || '').trim() !== '') {
                    // Preserva selección guardada aunque no venga en el set actual (ej.: snapshot distinto).
                    filter.valueOptions.push({ label: `${String(filter.value)} (valor previo)`, value: filter.value });
                } else if (!ok) {
                    filter.value = 'TODOS';
                }
            }
            return filter;
        });
    }

    hydrateTablesInSlides(slidesIn) {
        return (slidesIn || []).map((s) => ({
            ...s,
            excludeFromExport: !!s.excludeFromExport,
            tables: (s.tables || []).map((t) => {
                const nt = this.normalizeTableChartConfig(t);
                const sd = this.parsedExcelData?.[nt.sheetName];
                if (sd) {
                    nt.columnOptions = [{ label: 'Sin Filtro', value: 'TODOS' }, ...sd.allColumns];
                    this.rehydrateTableFilterOptions(nt, sd);
                } else if (!nt.columnOptions?.length) {
                    nt.columnOptions = [{ label: 'Sin Filtro', value: 'TODOS' }];
                }
                if (this.isPivotBlock(nt)) {
                    this.ensurePivotColumnDefaults(nt, sd);
                } else {
                    this.ensureChartColumnDefaults(nt);
                }
                return nt;
            })
        }));
    }

    handleActivePresentationChange(event) {
        const newId = event.detail.value;
        if (!newId || newId === this.activePresentationId) return;
        this.persistActivePresentationSlides();
        this.activePresentationId = newId;
        const dest = this.pptPresentations.find((p) => p.id === newId);
        this.slidesConfig = this.hydrateTablesInSlides(dest?.slidesConfig || []);
        this.activeSections = [];
        this.syncPresentationLabelDraft();
        this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
    }

    handlePresentationLabelInput(event) {
        const v = event.detail?.value ?? '';
        const id = this.activePresentationId;
        this.presentationLabelDraft = v;
        this.pptPresentations = this.pptPresentations.map((p) =>
            p.id === id ? { ...p, label: (v || '').trim() || 'Sin nombre' } : p
        );
    }

    addPresentationEmpty() {
        this.persistActivePresentationSlides();
        const id = `pres_${Date.now()}`;
        const n = this.pptPresentations.length + 1;
        this.pptPresentations = [...this.pptPresentations, { id, label: `Variante ${n}`, slidesConfig: [] }];
        this.activePresentationId = id;
        this.slidesConfig = [];
        this.activeSections = [];
        this.syncPresentationLabelDraft();
        this.showToast('Nueva variante', 'Añade diapositivas a esta presentación o duplica otra.', 'info');
    }

    duplicateActivePresentation() {
        this.persistActivePresentationSlides();
        const src = this.pptPresentations.find((p) => p.id === this.activePresentationId);
        if (!src) return;
        const id = `pres_${Date.now()}`;
        const copySlides = JSON.parse(JSON.stringify(src.slidesConfig || []));
        const labelBase = src.label || 'Presentación';
        this.pptPresentations = [...this.pptPresentations, { id, label: `${labelBase} (copia)`, slidesConfig: copySlides }];
        this.activePresentationId = id;
        this.slidesConfig = this.hydrateTablesInSlides(copySlides);
        this.activeSections = [];
        this.syncPresentationLabelDraft();
        this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
        this.showToast('Duplicada', `Se creó «${labelBase} (copia)».`, 'success');
    }

    async removeActivePresentation() {
        if (!this.canRemovePresentation) return;
        const cur = this.pptPresentations.find((p) => p.id === this.activePresentationId);
        const curLabel = cur?.label || 'esta variante';
        const ok = await this.confirmDeletion(
            `¿Eliminar la variante «${curLabel}» y todas sus diapositivas? No se aplicará hasta que pulses «Guardar diseño».`,
            'Eliminar variante'
        );
        if (!ok) return;
        this.persistActivePresentationSlides();
        const curId = this.activePresentationId;
        const remaining = this.pptPresentations.filter((p) => p.id !== curId);
        this.pptPresentations = remaining;
        this.activePresentationId = remaining[0].id;
        this.slidesConfig = this.hydrateTablesInSlides(remaining[0].slidesConfig || []);
        this.activeSections = [];
        this.syncPresentationLabelDraft();
        this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
    }

    /** PptxGenJS empaquetado usa `pptx.charts.*`; `ChartType` antiguo puede fallar en torta/líneas/anillo. */
    normalizeHex6(raw) {
        const h = (raw || '').replace('#', '').trim().substring(0, 6);
        return /^[0-9A-Fa-f]{6}$/.test(h) ? h.toUpperCase() : null;
    }

    /** Paleta corporativa + acentos (sin #) para export PPTX */
    getModernChartPaletteHex(primaryRaw, secondaryRaw) {
        const p = this.normalizeHex6(primaryRaw) || '263B7A';
        const s = this.normalizeHex6(secondaryRaw) || '64748B';
        const merged = [p, s];
        CHART_PALETTE_EXTRA.forEach(c => { if (!merged.includes(c)) merged.push(c); });
        return merged;
    }

    /** Colores #RRGGBB para vista previa HTML (conic gradient, leyendas) */
    getCssChartColors() {
        const p = this.normalizeHex6(this.currentTemplateColors?.primary) || '263B7A';
        const s = this.normalizeHex6(this.currentTemplateColors?.secondary) || '64748B';
        return this.getModernChartPaletteHex(p, s).map(h => `#${h}`);
    }

    /**
     * Opciones de gráfico alineadas al estilo “PowerPoint moderno” (bordes blancos entre series, % en tortas, etc.)
     */
    buildChartExportOptions(td, primaryColor6, secondaryColor6, fontName, chartTitle) {
        const palette = this.getModernChartPaletteHex(primaryColor6, secondaryColor6);
        const type = td.chartType || 'bar';
        const showLeg = td.chartShowLegend !== false;
        const legPos = td.chartLegendPos || 'b';
        const showVal = td.chartShowValue !== false;
        const titleCol = this.normalizeHex6(primaryColor6) || '263B7A';

        const base = {
            showLegend: showLeg,
            legendPos: legPos,
            legendFontSize: 11,
            legendColor: '334155',
            legendFontFace: fontName,
            showTitle: true,
            title: chartTitle,
            titleFontFace: fontName,
            titleColor: titleCol,
            chartColors: palette,
            chartArea: {
                roundedCorners: true,
                border: { pt: 0.75, color: 'E2E8F0' },
                fill: { color: 'FFFFFF' }
            },
            plotArea: {
                border: { pt: 0.5, color: 'F1F5F9' }
            },
            dataLabelFontFace: fontName,
            dataLabelFontSize: 10,
            dataLabelColor: '1E293B'
        };

        if (type === 'pie' || type === 'doughnut') {
            return {
                ...base,
                titleFontSize: 15,
                showValue: showVal,
                showPercent: true,
                showLeaderLines: true,
                dataLabelPosition: 'outEnd',
                dataBorder: { pt: 1.25, color: 'FFFFFF' },
                dataLabelFormatCode: '#,##0',
                catLabelFormatCode: '#,##0',
                ...(type === 'doughnut' ? { holeSize: 52 } : {})
            };
        }
        if (type === 'line') {
            return {
                ...base,
                titleFontSize: 13,
                showValue: showVal,
                lineSize: 2.75,
                lineSmooth: true,
                lineDataSymbol: 'circle',
                lineDataSymbolSize: 8,
                lineDataSymbolLineColor: palette[0],
                dataLabelFormatCode: '#,##0',
                valGridLine: 'none',
                catGridLine: 'none'
            };
        }
        return {
            ...base,
            titleFontSize: 13,
            showValue: showVal,
            barDir: 'col',
            barGrouping: 'clustered',
            barGapWidthPct: 42,
            barOverlapPct: 0,
            dataLabelFormatCode: '#,##0',
            dataBorder: { pt: 0.75, color: 'FFFFFF' }
        };
    }

    resolvePptxChartType(pptx, chartType) {
        const t = chartType || 'bar';
        const ch = pptx.charts;
        if (ch) {
            if (t === 'pie') return ch.PIE;
            if (t === 'doughnut') return ch.DOUGHNUT;
            if (t === 'line') return ch.LINE;
            return ch.BAR;
        }
        const ct = pptx.ChartType;
        if (ct) {
            if (t === 'pie') return ct.pie || ct.PIE;
            if (t === 'doughnut') return ct.doughnut || ct.DOUGHNUT;
            if (t === 'line') return ct.line || ct.LINE;
            return ct.bar || ct.BAR;
        }
        return null;
    }

    formatDesignOptionLabel(rec) {
        if (!rec?.Name) return '';
        let suf = '';
        if (rec.LastModifiedDate) {
            try {
                const d = new Date(rec.LastModifiedDate);
                suf = ` · ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}`;
            } catch (e) { /* ignore */ }
        }
        return `${rec.Name}${suf}`;
    }

    get slidesForAccordion() {
        const n = this.slidesConfig.length;
        /* Variantes destino para "Mover a otra variante" (excluye la activa). */
        const otherVariantOptions = (this.pptPresentations || [])
            .filter((p) => p.id !== this.activePresentationId)
            .map((p) => ({ label: p.label || 'Sin nombre', value: p.id }));
        const canMoveToVariant = otherVariantOptions.length > 0;
        const filterMode = this.slidesFilterMode;
        const activePresentation = (this.pptPresentations || []).find((p) => p.id === this.activePresentationId);
        const activePresentationLabel = activePresentation && activePresentation.label ? activePresentation.label : '';
        const showVariantChip = (this.pptPresentations || []).length > 1 && !!activePresentationLabel;
        const openSet = new Set(Array.isArray(this.activeSections) ? this.activeSections : []);
        const rowsAll = this.slidesConfig.map((s, i) => {
            const diag = this.computeSlideExportHints(s);
            const excluded = !!s.excludeFromExport;
            let label = `${i + 1}. ${s.title || 'Sin título'}`;
            if (excluded) label += ' · no exporta';
            else if (diag.issues.length) label += ` · \u26A0\uFE0F`;
            /* tablesView añade número de bloque 1-based y enriquece cada filter con flags de UI
               (mostrar dropdown/input/rango según operador). No muta el storage, solo la vista. */
            const tablesView = (s.tables || []).map((t, ti) => ({
                ...t,
                blockNumber: ti + 1,
                filters: (t.filters || []).map((f) => {
                    const operator = resolveFilterOperator(f);
                    const spec = FILTER_OPERATOR_MAP[operator] || FILTER_OPERATOR_MAP.eq;
                    const needsValue = spec.needsValue;
                    const isRange = spec.value === 'between';
                    const isNumeric = spec.valueKind === 'number' || isRange;
                    const useDropdown = spec.value === 'eq' || spec.value === 'neq';
                    return {
                        ...f,
                        operator,
                        showValueInput: needsValue && !useDropdown && !isRange,
                        showValueDropdown: needsValue && useDropdown,
                        showValueRange: isRange,
                        valueInputType: isNumeric ? 'number' : 'text',
                        valueLabel: isRange ? 'Desde' : 'Valor',
                        value2Label: 'Hasta'
                    };
                })
            }));
            const hasLogo = !!s.logoBase64;

            /* Chips visuales por slide (Tabla / Subtabla / Gráfico / Vacía).
               Solo informativos: derivan de tables[] sin modificar el storage. */
            const typeMap = new Map();
            (s.tables || []).forEach((t) => {
                if (t.flagPivotBlock) typeMap.set('pivot', 'Subtabla');
                else if (t.chartSolo) typeMap.set('chart', 'Gráfico');
                else {
                    typeMap.set('table', 'Tabla');
                    if (t.hasChart) typeMap.set('chart', 'Gráfico');
                }
            });
            const slideTypeChips = Array.from(typeMap.entries()).map(([kind, lbl], j) => ({
                id: `${s.id}_typ_${j}`,
                label: lbl,
                className: `slide-chip slide-chip--type-${kind}`
            }));
            if (!slideTypeChips.length) {
                slideTypeChips.push({
                    id: `${s.id}_typ_empty`,
                    label: 'Vacía',
                    className: 'slide-chip slide-chip--type-empty'
                });
            }

            /* Chip de estado (Incluida / Excluida / Con alertas). */
            let slideStatusChip;
            if (excluded) {
                slideStatusChip = { label: 'Excluida', className: 'slide-chip slide-chip--excluded' };
            } else if (diag.issues.length) {
                slideStatusChip = { label: 'Con alertas', className: 'slide-chip slide-chip--alerts' };
            } else {
                slideStatusChip = { label: 'Incluida', className: 'slide-chip slide-chip--included' };
            }

            /* Chip de variante PPT (solo si hay >1 variante PPT, evita ruido). */
            const slideVariantChip = showVariantChip ? {
                label: activePresentationLabel,
                className: 'slide-chip slide-chip--variant'
            } : null;

            /* Conteo de registros total de la slide (suma de las filas filtradas
               de cada bloque tabla / chart-solo del slide). No incluye pivots
               porque no son "registros" sino agregaciones. Solo cálculo informativo. */
            let slideRecordCount = 0;
            let hasCountableBlocks = false;
            (s.tables || []).forEach((tb) => {
                if (tb.flagPivotBlock) return;
                const sd = this.parsedExcelData?.[tb.sheetName];
                if (!sd || !Array.isArray(sd.rows)) return;
                let rows = sd.rows;
                (tb.filters || []).forEach((f) => {
                    if (isFilterUsableAdvanced(f)) rows = rows.filter((r) => applyBlockFilter(r[f.column], f));
                });
                slideRecordCount += rows.length;
                hasCountableBlocks = true;
            });
            const slideRecordChip = hasCountableBlocks ? {
                label: `${slideRecordCount.toLocaleString('es-CL')} registros`,
                className: 'slide-chip slide-chip--records'
            } : null;

            /* Tipo de thumbnail (clase CSS visual). Deriva del contenido. */
            let thumbKind = 'empty';
            if (excluded) {
                thumbKind = 'excluded';
            } else if (!(s.tables || []).length) {
                thumbKind = 'empty';
            } else {
                const tbls = s.tables || [];
                const hasPivot = tbls.some((t) => t.flagPivotBlock);
                const hasChartOnly = tbls.some((t) => t.chartSolo);
                const hasTable = tbls.some((t) => !t.flagPivotBlock && !t.chartSolo);
                const anyHasChart = tbls.some((t) => t.hasChart && !t.flagPivotBlock && !t.chartSolo);
                if (hasTable && anyHasChart) thumbKind = 'mixed';
                else if (hasTable) thumbKind = 'table';
                else if (hasChartOnly) thumbKind = 'chart';
                else if (hasPivot) thumbKind = 'pivot';
            }

            /* Opciones del menú "Mover" del header de cada card. Tres acciones rápidas + opción a variante. */
            const moveMenuOptions = [
                { label: 'Subir', value: 'up', icon: 'utility:chevronup', disabled: i === 0 },
                { label: 'Bajar', value: 'down', icon: 'utility:chevrondown', disabled: i === n - 1 }
            ];

            /* Estado expandido/colapsado: viene de activeSections (no duplico state). */
            const isExpanded = openSet.has(s.id);

            const cardClasses = ['slide-card'];
            if (excluded) cardClasses.push('slide-card--excluded');
            if (diag.issues.length) cardClasses.push('slide-card--has-issues');
            if (isExpanded) cardClasses.push('slide-card--expanded');

            return {
                ...s,
                tables: tablesView,
                accordionLabel: label,
                slidePos: i,
                slideMoveUpDisabled: i === 0,
                slideMoveDownDisabled: i === n - 1,
                slideIncludedInExport: !excluded,
                slideExportIssueTexts: diag.issues.map((x, j) => ({ id: `${s.id}_ex_${j}`, text: x.text })),
                slideExportHasIssues: diag.issues.length > 0,
                slideMockupClass: `slide-mockup${excluded ? ' slide-mockup--excluded' : ''}`,
                moveToVariantOptions: otherVariantOptions,
                canMoveToVariant,
                logoCorner: s.logoCorner || 'top-right',
                logoSizePct: String(s.logoSizePct || 12),
                hasLogo,
                logoControlsDisabled: !hasLogo,
                slideTypeChips,
                slideStatusChip,
                slideVariantChip,
                slideHasVariantChip: !!slideVariantChip,
                slideRecordChip,
                slideHasRecordChip: !!slideRecordChip,
                slideRecordCount,
                /* Nuevo modelo de card-row */
                slideNumber: i + 1,
                slideTitleClean: s.title || 'Sin título',
                cardClass: cardClasses.join(' '),
                thumbClass: `slide-thumb slide-thumb--${thumbKind}`,
                thumbKind,
                isExpanded,
                expandCaretIcon: isExpanded ? 'utility:chevrondown' : 'utility:chevronright',
                expandAriaExpanded: isExpanded ? 'true' : 'false',
                moveMenuOptions
            };
        });

        /* Aplica el filtro visual (no modifica slidesConfig). */
        if (filterMode === 'included')  return rowsAll.filter((r) => !r.excludeFromExport);
        if (filterMode === 'excluded')  return rowsAll.filter((r) => !!r.excludeFromExport);
        if (filterMode === 'issues')    return rowsAll.filter((r) => r.slideExportHasIssues);
        return rowsAll;
    }

    get exportableSlideCount() {
        return (this.slidesConfig || []).filter((s) => !s.excludeFromExport).length;
    }

    get excludedSlideCount() {
        return (this.slidesConfig || []).filter((s) => s.excludeFromExport).length;
    }

    get hasExcludedSlides() {
        return this.excludedSlideCount > 0;
    }

    get exportSlideSummaryText() {
        const t = (this.slidesConfig || []).length;
        const e = this.exportableSlideCount;
        if (!t) return '';
        return `${e}/${t} diapositivas en el PPT`;
    }

    /**
     * Indicadores de contenido vacío o incompleto (solo diagnóstico UI; no bloquea salvo export).
     */
    computeSlideExportHints(slideDef) {
        const issues = [];
        const tables = slideDef.tables || [];
        if (!tables.length) {
            issues.push({ code: 'NO_BLOCKS', text: 'Sin bloques (ni tabla ni gráfico)' });
            return { issues };
        }
        tables.forEach((tb, ti) => {
            const bn = ti + 1;
            const t = this.normalizeTableChartConfig(tb);
            const sheet = (t.sheetName || '').trim();
            if (!sheet) {
                issues.push({ code: 'NO_SHEET', text: `Bloque ${bn}: sin hoja Excel` });
                return;
            }
            const sheetData = this.parsedExcelData?.[sheet];
            if (!sheetData) {
                issues.push({ code: 'BAD_SHEET', text: `Bloque ${bn}: hoja no disponible` });
                return;
            }
            let filteredRows = sheetData.rows;
            (t.filters || []).forEach((f) => {
                if (isFilterUsableAdvanced(f)) {
                    filteredRows = filteredRows.filter((r) => applyBlockFilter(r[f.column], f));
                }
            });
            const cols = t.selectedColumns || [];
            const chartSolo = this.isChartSoloBlock(t);

            if (this.isPivotBlock(t)) {
                this.ensurePivotColumnDefaults(t, sheetData);
                const agg = (t.pivotAggregation || 'sum').toLowerCase();
                const g = (t.pivotGroupColumn || '').trim();
                if (!g) {
                    issues.push({ code: 'PIVOT_NO_GROUP', text: `Subtabla bloque ${bn}: elige columna de agrupación` });
                    return;
                }
                if (agg !== 'count' && !(t.pivotValueColumn || '').trim()) {
                    issues.push({ code: 'PIVOT_NO_VAL', text: `Subtabla bloque ${bn}: elige columna de medida` });
                    return;
                }
                const valCol = agg === 'count' ? (g || '').trim() : (t.pivotValueColumn || '').trim();
                const { labels } = this.aggregateChartSeries(filteredRows, g, valCol, agg);
                if (!labels.length) {
                    issues.push({ code: 'PIVOT_EMPTY', text: `Subtabla bloque ${bn}: sin datos` });
                }
                return;
            }

            if (chartSolo) {
                this.ensureChartColumnDefaults(t);
                const core = this.computeChartAggregation(t, filteredRows);
                if (!core || !core.labels.length) {
                    issues.push({ code: 'CHART_EMPTY', text: `Solo gráfico (bloque ${bn}): sin datos` });
                }
                return;
            }

            if (!cols.length) {
                issues.push({ code: 'NO_COLS', text: `Tabla bloque ${bn}: sin columnas` });
            }
            if (cols.length > 0 && filteredRows.length === 0) {
                issues.push({ code: 'NO_ROWS', text: `Tabla bloque ${bn}: 0 filas (revisa filtros)` });
            }
            if (t.hasChart) {
                this.ensureChartColumnDefaults(t);
                const core = this.computeChartAggregation(t, filteredRows);
                if (!core || !core.labels.length) {
                    issues.push({ code: 'CHART_SIDE_EMPTY', text: `Gráfico en bloque ${bn}: sin datos` });
                }
            }
        });
        return { issues };
    }

    get chartClipboardEmpty() {
        return !this.chartClipboardPayload;
    }
    
    get alignOptions() { return [{label: 'Izquierda', value: 'left'}, {label: 'Centro', value: 'center'}, {label: 'Derecha', value: 'right'}]; }
    /* Opciones de densidad de tabla por bloque. 'auto' deja el comportamiento
       histórico (autoajuste según longitud de texto). Los otros tres son
       presets explícitos que el usuario controla cuando quiere uniformidad
       entre slides o más/menos filas. */
    get tableDensityOptions() {
        return [
            { label: 'Automática (recomendado)', value: 'auto' },
            { label: 'Compacta (más filas por slide)', value: 'compact' },
            { label: 'Normal', value: 'normal' },
            { label: 'Espaciada (más legible, menos filas)', value: 'spacious' }
        ];
    }
    get progressBarStyle() { return `width: ${this.exportProgress}%;`; }

    normalizeTableChartConfig(raw) {
        const t = typeof raw === 'object' && raw !== null ? { ...raw } : {};
        if (t.blockType === undefined) t.blockType = 'detail';
        if (t.pivotGroupColumn === undefined) t.pivotGroupColumn = '';
        if (t.pivotValueColumn === undefined) t.pivotValueColumn = '';
        if (t.pivotAggregation === undefined) t.pivotAggregation = 'sum';
        if (t.pivotShowTotal === undefined) t.pivotShowTotal = true;
        if (t.pivotOrientation === undefined) t.pivotOrientation = 'vertical';
        if (t.pivotCategorySort === undefined) t.pivotCategorySort = 'appearance';
        if (t.chartAggregation === undefined) t.chartAggregation = 'sum';
        if (t.chartShowLegend === undefined) t.chartShowLegend = true;
        if (t.chartLegendPos === undefined) t.chartLegendPos = 'b';
        if (t.chartShowValue === undefined) t.chartShowValue = true;
        if (t.chartSizePreset === undefined) t.chartSizePreset = 'medium';
        if (t.chartPosition === undefined) t.chartPosition = 'right';
        if (t.chartTitle === undefined) t.chartTitle = '';
        if (t.chartCategoryColumn === undefined) t.chartCategoryColumn = '';
        if (t.chartValueColumn === undefined) t.chartValueColumn = '';
        if (t.chartCategoryOptions === undefined) t.chartCategoryOptions = [];
        if (t.chartValueOptions === undefined) t.chartValueOptions = [];
        if (t.pivotGroupOptions === undefined) t.pivotGroupOptions = [];
        if (t.pivotValueOptions === undefined) t.pivotValueOptions = [];
        if (t.configBoxClass === undefined) t.configBoxClass = 'table-config-box';
        if (t.previewHeaderCells === undefined) t.previewHeaderCells = [];
        if (t.selectedColumnOrderHints === undefined) t.selectedColumnOrderHints = [];
        /* Título visible por bloque (tabla / subtabla / chart-solo). Solo se renderiza
           en el PPT cuando NO está vacío — backward compatible con bloques antiguos. */
        if (t.blockTitle === undefined) t.blockTitle = '';
        /* Modo "respetar anchos del Excel": cuando true y el ancho total excede el slide,
           la tabla se parte horizontalmente en varios slides PPT en lugar de comprimirse. */
        if (t.respectOriginalWidths === undefined) t.respectOriginalWidths = false;
        /* Densidad de la tabla en el PPT exportado:
             'auto'     → el sistema decide (defaults dinámicos según longitud de texto)
             'compact'  → fuente más pequeña + padding mínimo → más filas por slide
             'normal'   → defaults explícitos (equivalente a 'auto' para datos cortos)
             'spacious' → fuente más grande + padding amplio → menos filas, más legible
           Aplica al ancho del padding y al tamaño de fuente, lo que a su vez impacta
           cuántas filas caben por slide en la paginación manual. */
        if (t.tableDensity === undefined) t.tableDensity = 'auto';
        /* Override opcional del número de filas por slide. Si null/0/'', se usa
           el cálculo automático. Si tiene valor > 0, fuerza ese máximo, útil
           para uniformar slides (p.ej. exactamente 10 filas por slide).
           Atención: si los textos son muy largos, forzar muchas filas puede
           hacer que el contenido se desborde visualmente del slide. */
        if (t.maxRowsPerSlideOverride === undefined) t.maxRowsPerSlideOverride = null;
        t.flagPivotBlock = (t.blockType || 'detail') === 'pivot';
        return t;
    }

    isChartSoloBlock(table) {
        return (table.chartPosition || '') === 'solo';
    }

    isPivotBlock(table) {
        return (table.blockType || 'detail') === 'pivot';
    }

    ensurePivotColumnDefaults(table, sheetData) {
        const all = sheetData?.allColumns?.map((c) => c.value) || [];
        const g = (table.pivotGroupColumn || '').trim();
        const v = (table.pivotValueColumn || '').trim();
        if (!g && all[0]) table.pivotGroupColumn = all[0];
        if (!v && all[1]) table.pivotValueColumn = all[1];
        else if (!v && all[0]) table.pivotValueColumn = all[0];
    }

    pivotMetricHeaderLabel(table) {
        const aggRaw = (table.pivotAggregation || 'sum').toLowerCase();
        const nm = CHART_AGG_LABELS[aggRaw] || aggRaw.toUpperCase();
        const vc = (table.pivotValueColumn || '').trim();
        return vc ? `${nm} (${vc})` : nm;
    }

    formatPivotMetricDisplay(table, numericValue, idxRow) {
        const aggRaw = (table.pivotAggregation || 'sum').toLowerCase();
        if (aggRaw === 'count') return String(Math.round(Number(numericValue) || 0));
        const n = Number(numericValue);
        if (aggRaw === 'avg') return Number.isFinite(n) ? this.formatChartAxisNumber(n) : '';
        return this.formatChartAxisNumber(n);
    }

    /* Reparte las columnas en chunks tales que cada chunk quepa en `availableWidth` pulgadas.
       Devuelve un array de arrays de índices (referentes a `selectedColumns`).
       Si `anchorFirstCol` es true y la primera columna no es demasiado ancha, se inyecta
       como primera columna en cada chunk (excepto el chunk 1) para conservar el "identificador"
       de la fila (típico caso: columna "Ticket" / "Nombre Cliente").
       Garantiza que ninguna columna individual quede sin asignar (si una columna sola excede
       availableWidth, ocupa su propio chunk forzosamente). */
    splitColumnsIntoChunks(realInchWidths, availableWidth, anchorFirstCol) {
        const n = realInchWidths.length;
        if (n === 0) return [];
        const chunks = [];
        const firstColW = realInchWidths[0];
        const anchorOk = anchorFirstCol === true && firstColW > 0 && firstColW <= availableWidth * 0.45;

        let currentChunk = [0];
        let currentWidth = realInchWidths[0];

        for (let i = 1; i < n; i++) {
            const w = realInchWidths[i];
            if (currentWidth + w > availableWidth && currentChunk.length > 0) {
                chunks.push(currentChunk);
                if (anchorOk) {
                    currentChunk = [0, i];
                    currentWidth = firstColW + w;
                } else {
                    currentChunk = [i];
                    currentWidth = w;
                }
            } else {
                currentChunk.push(i);
                currentWidth += w;
            }
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);
        return chunks;
    }

    ensureChartColumnDefaults(table) {
        const cols = table.selectedColumns || [];
        const sc = cols.map(c => c.trim());
        let cat = (table.chartCategoryColumn || '').trim();
        let val = (table.chartValueColumn || '').trim();
        if (!cat && sc[0]) cat = sc[0];
        if (!val && sc[1]) val = sc[1];
        if (cat && !sc.includes(cat)) cat = sc[0] || '';
        if (val && !sc.includes(val)) val = sc[1] || sc[0] || '';
        table.chartCategoryColumn = cat;
        table.chartValueColumn = val;
    }

    parseNumericForChart(raw) {
        if (raw === undefined || raw === null || raw === '') return null;
        const cleanStr = String(raw).replace(/[^0-9.,-]/g, '').replace(',', '.');
        const parsed = parseFloat(cleanStr);
        return Number.isNaN(parsed) ? null : parsed;
    }

    aggregateChartSeries(rows, categoryCol, valueCol, aggregation) {
        const catKey = categoryCol.trim();
        const valKey = valueCol.trim();
        const agg = aggregation || 'sum';
        const bucket = {};

        rows.forEach(r => {
            let rawLabel = r[catKey];
            if (rawLabel === undefined && r[categoryCol] !== undefined) rawLabel = r[categoryCol];
            const label = rawLabel !== undefined && rawLabel !== null && rawLabel !== '' ? String(rawLabel) : 'Sin asignar';

            let rawVal = r[valKey];
            if (rawVal === undefined) rawVal = r[valueCol];
            const num = this.parseNumericForChart(rawVal);

            if (!bucket[label]) {
                bucket[label] = { sum: 0, count: 0, nSum: 0, nCount: 0, min: null, max: null };
            }
            const b = bucket[label];
            b.count += 1;
            if (num !== null) {
                b.nSum += num;
                b.nCount += 1;
                b.sum += num;
                if (b.min === null || num < b.min) b.min = num;
                if (b.max === null || num > b.max) b.max = num;
            }
        });

        const labels = Object.keys(bucket);
        const values = labels.map(l => {
            const b = bucket[l];
            switch (agg) {
                case 'count':
                    return b.count;
                case 'avg':
                    return b.nCount ? b.nSum / b.nCount : 0;
                case 'max':
                    return b.max !== null ? b.max : 0;
                case 'min':
                    return b.min !== null ? b.min : 0;
                case 'sum':
                default:
                    return b.sum;
            }
        });
        return { labels, values };
    }

    applyPivotCategorySort(labels, values, sortMode) {
        const mode = sortMode || 'appearance';
        if (!labels.length || mode === 'appearance') {
            return { labels: [...labels], values: [...values] };
        }
        const pairs = labels.map((l, i) => ({ label: l, value: values[i] }));
        switch (mode) {
            case 'alpha':
                pairs.sort((a, b) => String(a.label).localeCompare(String(b.label), 'es', { sensitivity: 'base', numeric: true }));
                break;
            case 'alpha_desc':
                pairs.sort((a, b) => String(b.label).localeCompare(String(a.label), 'es', { sensitivity: 'base', numeric: true }));
                break;
            case 'value_asc':
                pairs.sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
                break;
            case 'value_desc':
                pairs.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
                break;
            default:
                break;
        }
        return { labels: pairs.map((p) => p.label), values: pairs.map((p) => p.value) };
    }

    finalizePivotAggregation(filteredRows, table) {
        const agg = (table.pivotAggregation || 'sum').toLowerCase();
        const g = (table.pivotGroupColumn || '').trim();
        const vCol = agg === 'count' ? g : (table.pivotValueColumn || '').trim();
        let { labels, values } = this.aggregateChartSeries(filteredRows, g, vCol, agg);
        ({ labels, values } = this.applyPivotCategorySort(labels, values, table.pivotCategorySort));
        return { agg, g, vCol, labels, values };
    }

    computeChartAggregation(table, filteredRows) {
        const cols = table.selectedColumns || [];
        const catCol = (table.chartCategoryColumn || cols[0] || '').trim();
        const valCol = (table.chartValueColumn || cols[1] || '').trim();
        if (!table.hasChart || !catCol || !valCol) return null;
        const sc = cols.map(c => c.trim());
        if (!sc.includes(catCol) || !sc.includes(valCol)) return null;

        const agg = table.chartAggregation || 'sum';
        const { labels, values } = this.aggregateChartSeries(filteredRows, catCol, valCol, agg);
        if (!labels.length) return null;
        const maxVal = Math.max(...values.map(v => Math.abs(Number(v) || 0)), 1e-9);
        const title = (table.chartTitle && table.chartTitle.trim()) ? table.chartTitle.trim() : `Resumen: ${catCol}`;
        const aggShort = CHART_AGG_LABELS[agg] || agg;
        const subtitle = `${aggShort} · ${valCol}`;
        return { labels, values, maxVal, title, subtitle, catCol, valCol };
    }

    formatChartAxisNumber(v) {
        const n = Number(v);
        if (Number.isNaN(n)) return String(v);
        if (Math.abs(n) >= 1000 || Math.abs(n - Math.round(n)) > 1e-6) return n.toLocaleString('es-ES', { maximumFractionDigits: 2 });
        return String(Math.round(n * 100) / 100);
    }

    buildChartSeriesModel(table, filteredRows) {
        const core = this.computeChartAggregation(table, filteredRows);
        if (!core) return null;
        const chartType = table.chartType || 'bar';
        const palette = this.getCssChartColors();
        const hint = 'Vista aproximada; el PPT usa el mismo tipo y datos.';

        if (chartType === 'pie' || chartType === 'doughnut') {
            const total = core.values.reduce((acc, v) => acc + Math.abs(Number(v) || 0), 0) || 1;
            let offsetDeg = 0;
            const segments = core.labels.map((l, i) => {
                const v = core.values[i];
                const num = Number(v) || 0;
                const share = Math.abs(num) / total;
                const sweepDeg = share * 360;
                const pctOfTotal = share * 100;
                const color = palette[i % palette.length];
                const seg = {
                    id: `seg_${i}`,
                    label: l,
                    valueDisplay: this.formatChartAxisNumber(v),
                    pctLabel: `${pctOfTotal.toFixed(1).replace(/\.0$/, '')}%`,
                    color,
                    swatchStyle: `background-color: ${color}`,
                    offsetDeg,
                    sweepDeg
                };
                offsetDeg += sweepDeg;
                return seg;
            });
            const stops = segments.map(s => `${s.color} ${s.offsetDeg}deg ${s.offsetDeg + s.sweepDeg}deg`).join(', ');
            const ringStyle = `background: conic-gradient(${stops}); box-shadow: inset 0 0 0 2px rgba(255,255,255,0.95), 0 10px 28px rgba(15,23,42,0.12);`;
            return {
                variantBars: false,
                variantRadial: true,
                variantLine: false,
                title: core.title,
                subtitle: core.subtitle,
                chartType,
                segments,
                radialRingStyle: ringStyle,
                radialDonut: chartType === 'doughnut',
                legendHint: chartType === 'doughnut' ? 'Anillo' : 'Circular',
                hint
            };
        }

        if (chartType === 'line') {
            const max = core.maxVal || 1;
            const n = core.labels.length;
            const w = 100;
            const h = 42;
            const pts = core.labels.map((l, i) => {
                const v = core.values[i];
                const valAbs = Math.abs(Number(v) || 0);
                const yNorm = max ? valAbs / max : 0;
                const x = n <= 1 ? w / 2 : (i / (n - 1)) * w;
                const y = h - yNorm * (h - 8) - 4;
                return {
                    id: `ln_${i}`,
                    label: l,
                    valueDisplay: this.formatChartAxisNumber(v),
                    x,
                    y
                };
            });
            const polylinePoints = pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
            const lineStroke = palette[0] || '#263B7A';
            return {
                variantBars: false,
                variantRadial: false,
                variantLine: true,
                title: core.title,
                subtitle: core.subtitle,
                chartType,
                linePoints: polylinePoints,
                lineFillPoints: `${polylinePoints} ${w},${h} 0,${h}`,
                lineStroke,
                lineDots: pts,
                hint
            };
        }

        const max = core.maxVal;
        const bars = core.labels.map((l, i) => {
            const v = core.values[i];
            const pct = max ? (Math.abs(Number(v) || 0) / max) * 100 : 0;
            const fillHex = (palette[i % palette.length] || '#263B7A').replace('#', '');
            return {
                id: `cv_${i}`,
                label: l,
                valueDisplay: this.formatChartAxisNumber(v),
                fillStyle: `width: ${pct}%; background: linear-gradient(90deg, #${fillHex}, #${fillHex}dd);`
            };
        });
        return {
            variantBars: true,
            variantRadial: false,
            variantLine: false,
            title: core.title,
            subtitle: core.subtitle,
            bars,
            chartType,
            hint
        };
    }

    getChartSizePresetDims(preset) {
        switch (preset) {
            case 'small':
                return { w: 4.0, h: 2.6 };
            case 'large':
                return { w: 6.2, h: 4.2 };
            case 'medium':
            default:
                return { w: 5.0, h: 3.5 };
        }
    }

    @wire(getPptDesigns)
    wiredDesigns({ data, error }) {
        if (data) {
            this.designRecords = data;
            this.designOptions = data.map(d => ({ label: this.formatDesignOptionLabel(d), value: d.Id }));
            if (this.designOptions.length) {
                const validIds = new Set(this.designOptions.map(o => o.value));
                if (!this.selectedDesign || !validIds.has(this.selectedDesign)) {
                    this.selectedDesign = this.designOptions[0].value;
                }
                this.updatePreviewColors();
            }
        } else if (error) {
            this.showToast('Error', 'No se pudieron cargar los diseños de PPT.', 'error');
        }
    }

    get isGenerateDisabled() {
        return (
            !this.pptxLoaded ||
            !this.selectedDesign ||
            this.isParsingExcel ||
            this.slidesConfig.length === 0 ||
            this.exportableSlideCount === 0
        );
    }
    
    get formattedCoverDate() {
        if (!this.coverDate) return '';
        const dateObj = new Date(this.coverDate + 'T12:00:00');
        return `FECHA: ${dateObj.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}`;
    }

    get dynamicMockupStyle() { return `font-family: ${this.currentTemplateColors.font}; border-top: 4px solid ${this.currentTemplateColors.primary};`; }
    get dynamicHeaderStyle() { return `background-color: ${this.currentTemplateColors.primary}; color: #fff; padding: 12px 24px;`; }
    get dynamicCoverTitleStyle() { return `font-size: 1.4rem; font-weight: 900; color: ${this.currentTemplateColors.primary}; text-transform: uppercase;`; }
    get dynamicCoverSubtitleStyle() { return `font-size: 0.95rem; color: ${this.currentTemplateColors.secondary};`; }
    
    get modalColumnOptions() {
        const term = (this.columnsSearch || '').toLowerCase();
        if (!term) return this.allModalOptions;
        return this.allModalOptions.filter(o => (o.label || '').toLowerCase().includes(term));
    }

    renderedCallback() {
        if ((this.pptxLoaded && this.excelLoaded) || this.libsLoading) return;
        this.libsLoading = true;
        Promise.all([loadScript(this, PPTX_GEN), loadScript(this, EXCEL_JS)])
            .then(() => { 
                this.pptxLoaded = true; 
                this.excelLoaded = true; 
                
                const hasMemoryData = !!sessionStorage.getItem('pandora_transit_excel_base64');
                if (this.excelContentDocumentId || hasMemoryData) {
                    this.loadAndParseExcel(this.excelContentDocumentId); 
                } else {
                    this.isParsingExcel = false; 
                }
            })
            .catch(() => { this.showToast('Error', 'No se pudieron cargar las librerías.', 'error'); })
            .finally(() => { this.libsLoading = false; });
    }

    async updateProgress(progress, text) {
        this.exportProgress = progress;
        this.exportStatusText = text;
        await new Promise(resolve => setTimeout(resolve, 50)); 
    }

    handleDesignChange(e) {
        this.selectedDesign = e.detail.value;
        this.updatePreviewColors().then(() => {
            if (!this.slidesConfig?.length) return;
            this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
        });
    }
    
    async updatePreviewColors() {
        const designId = this.selectedDesign;
        this.bgImages = { portada: null, contenido: null, cierre: null };

        const cfg = this.designRecords.find(d => d.Id === designId);
        if (cfg) {
            this.currentTemplateColors.primary = cfg.Color_Primario__c || '#263B7A';
            this.currentTemplateColors.secondary = cfg.Color_Secundario__c || '#64748b';
            this.currentTemplateColors.font = cfg.Fuente_Corporativa__c || 'Calibri';

            if (cfg.Configuracion_JSON__c) {
                try {
                    const parsed = JSON.parse(cfg.Configuracion_JSON__c);
                    const docIds = [];
                    if (parsed?.slides?.portada?.bgDocId) docIds.push(parsed.slides.portada.bgDocId);
                    if (parsed?.slides?.contenido?.bgDocId) docIds.push(parsed.slides.contenido.bgDocId);
                    if (parsed?.slides?.cierre?.bgDocId) docIds.push(parsed.slides.cierre.bgDocId);

                    if (docIds.length > 0) {
                        const imgMap = await getBase64Images({ documentIds: docIds });
                        if (this.selectedDesign !== designId) return;
                        if (imgMap) {
                            if (parsed.slides.portada.bgDocId && imgMap[parsed.slides.portada.bgDocId]) {
                                this.bgImages.portada = `data:image/png;base64,${imgMap[parsed.slides.portada.bgDocId]}`;
                            }
                            if (parsed.slides.contenido.bgDocId && imgMap[parsed.slides.contenido.bgDocId]) {
                                this.bgImages.contenido = `data:image/png;base64,${imgMap[parsed.slides.contenido.bgDocId]}`;
                            }
                            if (parsed.slides.cierre.bgDocId && imgMap[parsed.slides.cierre.bgDocId]) {
                                this.bgImages.cierre = `data:image/png;base64,${imgMap[parsed.slides.cierre.bgDocId]}`;
                            }
                        }
                    }
                } catch (e) { console.error('Error cargando fondos', e); }
            }
        }
    }

    handleCoverChange(e) { this.includeCover = e.target.checked; }
    handleCoverTitleChange(e) { this.coverTitle = e.target.value; }
    handleCoverDateChange(e) { this.coverDate = e.target.value; }
    handleClosingChange(e) { this.includeClosing = e.target.checked; }
    handleClosingTextChange(e) { this.closingText = e.target.value; }
    goBack() { this.dispatchEvent(new CustomEvent('back')); }
    
    expandAll() { this.activeSections = this.slidesConfig.map(s => s.id); }
    collapseAll() { this.activeSections = []; }

    get accordionAllExpanded() {
        const ids = (this.slidesConfig || []).map((s) => s.id);
        if (!ids.length) return false;
        const open = this.activeSections || [];
        return ids.every((id) => open.includes(id));
    }

    get accordionToggleDisabled() {
        return !(this.slidesConfig && this.slidesConfig.length);
    }

    get accordionToggleLabel() {
        if (!this.slidesConfig?.length) return 'Panel';
        return this.accordionAllExpanded ? 'Contraer todas' : 'Expandir todas';
    }

    get accordionToggleIcon() {
        return this.accordionAllExpanded ? 'utility:contract_alt' : 'utility:expand_alt';
    }

    toggleAccordionSections() {
        if (this.accordionAllExpanded) this.collapseAll();
        else this.expandAll();
    }

    /* Toggle expand/collapse de UNA card de slide (sustituye el toggle interno del
       lightning-accordion-section que ya no usamos). Reusa activeSections como
       fuente única de verdad para no romper expandAll/collapseAll/resets globales. */
    handleSlideRowToggle(event) {
        if (!event || !event.currentTarget) return;
        const id = event.currentTarget.dataset.sid;
        if (!id) return;
        const open = Array.isArray(this.activeSections) ? [...this.activeSections] : [];
        const idx = open.indexOf(id);
        if (idx >= 0) open.splice(idx, 1);
        else open.push(id);
        this.activeSections = open;
    }

    /* Bloquea la propagación del click cuando se interactúa con los controles del
       header de cada card (toggle "En PPT", botones, combobox) para que no
       dispare accidentalmente el toggle de expand/collapse de la fila. */
    handleSlideRowActionsClick(event) {
        if (event && event.stopPropagation) event.stopPropagation();
    }

    /* Menú del split button "Nueva diapositiva":
       - "table": equivalente a click directo (con tabla inicial)
       - "empty": diapositiva vacía sin bloques
       (Mantiene compatibilidad con addSlide/addEmptySlide existentes.) */
    handleNewSlideMenuSelect(event) {
        const value = event && event.detail && event.detail.value;
        if (value === 'empty') this.addEmptySlide();
        else this.addSlide();
    }

    // POPUP DE VISTA PRELIMINAR (AHORA RESPETA EL LAYOUT EXACTO)
    async openPreviewModal() {
        this.isExporting = true;
        await this.updateProgress(40, 'Sincronizando plantilla...');
        await this.updatePreviewColors();
        await this.updateProgress(50, 'Generando Vista Preliminar...');

        const config = this.designRecords.find(d => d.Id === this.selectedDesign);
        const primaryColor = (config?.Color_Primario__c || '#263B7A').replace('#', '');
        const secColor = (config?.Color_Secundario__c || '#64748b').replace('#', '');
        
        let layout = { 
            slides: { 
                portada: { title: { x: 1.0, y: 3.0, w: 11.33, h: 2.5, fontSize: 32, align: 'center' } }, 
                contenido: { title: { x: 0.5, y: 0.3, w: 12.0, h: 0.8, fontSize: 24, align: 'left' }, subtitle: { x: 0.5, y: 0.9, w: 12.0, h: 0.5, fontSize: 14, align: 'left' }, table: { startY: 1.5 } }, 
                cierre: { title: { x: 1.0, y: 3.0, w: 11.33, h: 2.0, fontSize: 32, align: 'center' } } 
            } 
        };
        try { if (config?.Configuracion_JSON__c) { const parsed = JSON.parse(config.Configuracion_JSON__c); if (parsed?.slides) layout.slides = parsed.slides; } } catch (e) {}

        const toX = (val) => `${(Number(val) / 13.33) * 100}%`;
        const toY = (val) => `${(Number(val) / 7.5) * 100}%`;
        const toW = (val) => `${(Number(val) / 13.33) * 100}%`;
        const getAlign = (val) => { if(val === 'center') return 'center'; if(val === 'right') return 'flex-end'; return 'flex-start'; };

        let arr = [];
        
        if(this.includeCover) {
            arr.push({
                id: 'prev_cover',
                isCover: true,
                previewRootClass: 'ppt-slide-preview',
                bgStyle: this.bgImages.portada ? `background-image: url(${this.bgImages.portada}); background-size: cover; background-position: center;` : 'background-color: #f1f5f9;',
                title: this.coverTitle,
                date: this.formattedCoverDate,
                titleContainerStyle: `position:absolute; top:${toY(layout.slides.portada.title.y)}; left:${toX(layout.slides.portada.title.x)}; width:${toW(layout.slides.portada.title.w)}; height:${toY(layout.slides.portada.title.h)}; display:flex; align-items:center; justify-content:${getAlign(layout.slides.portada.title.align)};`,
                titleTextStyle: `font-size: clamp(14px, 1.8vw, 32px); font-weight:bold; color:#${primaryColor};`,
                dateStyle: `position:absolute; top:${toY(Number(layout.slides.portada.title.y) + 1.2)}; left:${toX(layout.slides.portada.title.x)}; width:${toW(layout.slides.portada.title.w)}; font-size:16px; color:#64748b; text-align:${layout.slides.portada.title.align || 'center'};`
            });
        }
        
        this.slidesConfig.forEach((s) => {
            let slideTables = [];
            (s.tables || []).forEach(t => {
                let sheetData = this.parsedExcelData[t.sheetName];
                if (!sheetData) {
                    return;
                }
                let filteredRows = sheetData.rows;
                (t.filters || []).forEach(f => {
                    if (isFilterUsableAdvanced(f)) {
                        filteredRows = filteredRows.filter(r => applyBlockFilter(r[f.column], f));
                    }
                });

                let tAlign = t.tableAlign || 'left';
                let flexAlign = 'flex-start';
                if (tAlign === 'center') flexAlign = 'center';
                if (tAlign === 'right') flexAlign = 'flex-end';

                const nt = this.normalizeTableChartConfig({ ...t });
                if (this.isPivotBlock(nt)) {
                    this.ensurePivotColumnDefaults(nt, sheetData);
                    const {
                        agg,
                        g,
                        labels,
                        values
                    } = this.finalizePivotAggregation(filteredRows, nt);
                    const hCat = g || '—';
                    const hVal = this.pivotMetricHeaderLabel(nt);
                    const orient = nt.pivotOrientation === 'horizontal' ? 'horizontal' : 'vertical';
                    let pivotHeaders;
                    let previewRowsHtml;

                    if (orient === 'horizontal') {
                        pivotHeaders = [
                            { id: 'mod_hz_corner', label: hCat },
                            ...labels.map((lb, idx) => ({ id: `mod_hz_${idx}`, label: String(lb) }))
                        ];
                        const cells = [{ id: 'mod_hz_mv0', value: hVal }];
                        labels.forEach((_lb, idx) => {
                            cells.push({
                                id: `mod_hz_mv${idx + 1}`,
                                value: this.formatPivotMetricDisplay(nt, values[idx], idx)
                            });
                        });
                        if (nt.pivotShowTotal && labels.length) {
                            pivotHeaders.push({ id: 'mod_hz_totcol', label: 'Total' });
                            let tot;
                            if (agg === 'avg') {
                                const s = values.reduce((a, b) => a + (Number(b) || 0), 0);
                                tot = s / values.length;
                            } else {
                                tot = values.reduce((a, b) => a + (Number(b) || 0), 0);
                            }
                            cells.push({
                                id: 'mod_hz_mvtot',
                                value: this.formatPivotMetricDisplay(nt, tot, -1)
                            });
                        }
                        previewRowsHtml = [{ id: 'mod_ppr_hz', cells }];
                    } else {
                        pivotHeaders = [
                            { id: 'mod_v0', label: hCat },
                            { id: 'mod_v1', label: hVal }
                        ];
                        previewRowsHtml = labels.slice(0, 5).map((lb, idx) => ({
                            id: `ppr_${idx}`,
                            cells: [
                                { id: `ppc_${idx}_0`, value: lb },
                                { id: `ppc_${idx}_1`, value: this.formatPivotMetricDisplay(nt, values[idx], idx) }
                            ]
                        }));
                    }
                    slideTables.push({
                        id: t.id,
                        chartOnly: false,
                        headers: pivotHeaders,
                        rows: previewRowsHtml,
                        wrapperStyle: `display: flex; justify-content: ${flexAlign}; width: 100%;`,
                        chartPreview: null
                    });
                    return;
                }

                let previewRowsHtml = filteredRows.slice(0, 5).map((r, idx) => {
                    let cells = t.selectedColumns.map((col, j) => {
                        let safeH = col.trim();
                        let val = r[safeH];
                        if (val === undefined) val = r[col];
                        let cellVal = (val !== null && val !== undefined && val !== '') ? String(val) : '-';
                        return { id: `tc_${idx}_${j}`, value: cellVal };
                    });
                    return { id: `pr_${idx}`, cells };
                });

                this.ensureChartColumnDefaults(nt);
                const chartPreview = nt.hasChart ? this.buildChartSeriesModel(nt, filteredRows) : null;
                const chartOnly = (nt.chartPosition || '') === 'solo';

                slideTables.push({
                    id: t.id,
                    chartOnly,
                    headers: chartOnly
                        ? []
                        : t.selectedColumns.map((col, j) => ({ id: `${t.id}_col_${j}`, label: col })),
                    rows: chartOnly ? [] : previewRowsHtml,
                    wrapperStyle: `display: flex; justify-content: ${chartOnly ? 'center' : flexAlign}; width: 100%;`,
                    chartPreview
                });
            });

            const prevDiag = this.computeSlideExportHints(s);
            arr.push({
                id: s.id,
                isContent: true,
                excludeFromExport: !!s.excludeFromExport,
                previewHasDiagnostic: prevDiag.issues.length > 0,
                previewDiagnosticLine: prevDiag.issues.map((x) => x.text).join(' · '),
                previewRootClass: `ppt-slide-preview${s.excludeFromExport ? ' ppt-slide-preview--excluded' : ''}`,
                bgStyle: this.bgImages.contenido ? `background-image: url(${this.bgImages.contenido}); background-size: cover; background-position: center;` : 'background-color: #ffffff;',
                title: s.title,
                subtitle: s.subtitle,
                titleContainerStyle: `position:absolute; top:${toY(layout.slides.contenido.title.y)}; left:${toX(layout.slides.contenido.title.x)}; width:${toW(layout.slides.contenido.title.w)}; height:${toY(layout.slides.contenido.title.h)}; display:flex; align-items:center; justify-content:${getAlign(layout.slides.contenido.title.align)};`,
                titleTextStyle: `font-size: clamp(14px, 1.8vw, 32px); font-weight:bold; color:#${primaryColor};`,
                subtitleContainerStyle: `position:absolute; top:${toY(layout.slides.contenido.subtitle.y)}; left:${toX(layout.slides.contenido.subtitle.x)}; width:${toW(layout.slides.contenido.subtitle.w)}; height:${toY(layout.slides.contenido.subtitle.h)}; display:flex; align-items:center; justify-content:${getAlign(layout.slides.contenido.subtitle.align)};`,
                subtitleTextStyle: `font-size: clamp(10px, 1.2vw, 18px); color:#${secColor};`,
                tableContainerStyle: `position:absolute; top:${toY(layout.slides.contenido.table.startY)}; left:0; width:100%; max-height:75%; overflow:auto; padding: 0 2.5%;`,
                tables: slideTables
            });
        });
        
        if(this.includeClosing) {
            arr.push({
                id: 'prev_closing',
                isClosing: true,
                previewRootClass: 'ppt-slide-preview',
                bgStyle: this.bgImages.cierre ? `background-image: url(${this.bgImages.cierre}); background-size: cover; background-position: center;` : 'background-color: #f1f5f9;',
                title: this.closingText,
                titleContainerStyle: `position:absolute; top:${toY(layout.slides.cierre.title.y)}; left:${toX(layout.slides.cierre.title.x)}; width:${toW(layout.slides.cierre.title.w)}; height:${toY(layout.slides.cierre.title.h)}; display:flex; align-items:center; justify-content:${getAlign(layout.slides.cierre.title.align)};`,
                titleTextStyle: `font-size: clamp(14px, 1.8vw, 32px); font-weight:bold; color:#${primaryColor};`
            });
        }

        this.previewSlidesArray = arr;
        this.isExporting = false;
        this.showPreviewModal = true;
    }
    
    closePreviewModal() {
        this.showPreviewModal = false;
    }

    async loadSavedPptConfig() {
        if(!this.reportId) return false;
        try {
            /* PPT por variante: si llega reportVariantId lo usamos; si no, Apex toma 'default'
               y promueve registros legacy automáticamente. */
            const json = await getPptConfigApex({ reportId: this.reportId, varianteId: this.reportVariantId || null });
            if(json) {
                const config = JSON.parse(json);
                const ok = this.applyLoadedPptConfig(config);
                if (!ok) return false;
                await this.updatePreviewColors();
                this.saveLocalBackupSnapshot('server_load');
                this._savedConfigSignature = this._computeBackupSignature();
                return true;
            }
        } catch(e) { console.error('Error cargando config PPT', e); }
        return false;
    }

    async savePptConfig() {
        if(!this.reportId) { this.showToast('Aviso', 'No se puede identificar el reporte para guardar.', 'warning'); return; }
        const config = this.buildPersistablePptConfig();
        const presentationsOut = config.presentations || [];
        this.saveLocalBackupSnapshot('before_remote_save');
        try {
            await savePptConfigApex({ reportId: this.reportId, varianteId: this.reportVariantId || null, jsonConfig: JSON.stringify(config) });
            this.pptPresentations = presentationsOut.map((p) => ({
                id: p.id,
                label: p.label,
                slidesConfig: p.slidesConfig
            }));
            const activePack = this.pptPresentations.find((x) => x.id === this.activePresentationId);
            this.slidesConfig = this.hydrateTablesInSlides(activePack?.slidesConfig || []);
            this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
            this.saveLocalBackupSnapshot('after_remote_save');
            this._savedConfigSignature = this._computeBackupSignature();
            this.showToast('Éxito', 'Configuración guardada.', 'success');
        } catch (e) {
            console.error(e);
            const detail =
                (e.body && typeof e.body.message === 'string' && e.body.message) ||
                (Array.isArray(e.body) && e.body[0]?.message) ||
                e.message ||
                'No se pudo guardar la configuración.';
            this.showToast('Error', detail, 'error');
        }
    }

    async loadAndParseExcel(documentId) {
        this.isParsingExcel = true;
        this.parsingStatusText = 'Preparando archivo Excel...';
        try {
            let base64Excel;
            const memoryBase64 = sessionStorage.getItem('pandora_transit_excel_base64');
            
            if (memoryBase64) {
                base64Excel = memoryBase64;
                this.parsingStatusText = 'Leyendo Excel desde memoria temporal...';
                sessionStorage.removeItem('pandora_transit_excel_base64'); 
            } else if (documentId) {
                this.parsingStatusText = 'Descargando Excel desde Salesforce Files...';
                base64Excel = await getExcelFileBase64({ documentId });
            } else {
                throw new Error('No hay datos disponibles para procesar.');
            }

            const binary = window.atob(base64Excel);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const workbook = new window.ExcelJS.Workbook();
            this.parsingStatusText = 'Parseando hojas y columnas...';
            await workbook.xlsx.load(bytes.buffer);
            
            this.parsedExcelData = {}; 
            this.sheetOptions = [];

            const getPptColor = (argb) => {
                if (!argb) return null;
                let c = String(argb).replace('#', '');
                return c.length === 8 ? c.substring(2) : c; 
            };

            /* Mapea un único side-border de ExcelJS (ej. cell.border.top) al
               formato que entiende pptxgenjs: { type, color, pt }.
               - 'thin'   → 0.75pt
               - 'medium' → 1.5pt
               - 'thick'  → 2.25pt
               - 'dashed' → tipo dash, 0.75pt
               - 'dotted' → tipo dash, 0.5pt (pptxgenjs no tiene dotted nativo)
               Si no hay borde o el estilo es desconocido, devuelve null. */
            const mapExcelSideBorderToPptx = (side) => {
                if (!side || !side.style) return null;
                const style = String(side.style).toLowerCase();
                const argb = side.color && side.color.argb;
                const color = getPptColor(argb) || 'DFE5EF';
                switch (style) {
                    case 'thin':       return { type: 'solid', color, pt: 0.75 };
                    case 'medium':     return { type: 'solid', color, pt: 1.5 };
                    case 'thick':      return { type: 'solid', color, pt: 2.25 };
                    case 'hair':       return { type: 'solid', color, pt: 0.25 };
                    case 'double':     return { type: 'solid', color, pt: 2 };
                    case 'dashed':
                    case 'mediumdashed':
                    case 'dashdot':
                    case 'mediumdashdot':
                    case 'dashdotdot':
                    case 'mediumdashdotdot':
                    case 'slantdashdot':
                        return { type: 'dash', color, pt: 0.75 };
                    case 'dotted':     return { type: 'dash', color, pt: 0.5 };
                    default:           return { type: 'solid', color, pt: 0.75 };
                }
            };

            /* Convierte el cell.border completo de ExcelJS (top/right/bottom/left)
               en el formato del parámetro `border` de pptxgenjs addTable.
               pptxgenjs acepta dos formas:
                 1) Un objeto único aplicado a los 4 lados
                 2) Un array [top, right, bottom, left] con objetos o 'none'
               Si los 4 lados son iguales (mismo color/estilo/grosor) devolvemos
               la forma simplificada. Si difieren, devolvemos el array. Si NO
               hay borde detectable, devolvemos null y se aplica el fallback
               del componente para no romper PPTs sin formato Excel previo. */
            const mapExcelBorderToPptx = (excelBorder) => {
                if (!excelBorder || typeof excelBorder !== 'object') return null;
                const t = mapExcelSideBorderToPptx(excelBorder.top);
                const r = mapExcelSideBorderToPptx(excelBorder.right);
                const b = mapExcelSideBorderToPptx(excelBorder.bottom);
                const l = mapExcelSideBorderToPptx(excelBorder.left);
                if (!t && !r && !b && !l) return null;
                const NONE = { type: 'none', pt: 0, color: 'FFFFFF' };
                const sides = [t || NONE, r || NONE, b || NONE, l || NONE];
                const sameAll = sides.every(s =>
                    s.type === sides[0].type && s.pt === sides[0].pt && s.color === sides[0].color
                );
                if (sameAll && sides[0].type !== 'none') {
                    return { type: sides[0].type, color: sides[0].color, pt: sides[0].pt };
                }
                return sides;
            };

            workbook.worksheets.forEach(ws => {
                this.sheetOptions.push({ label: ws.name, value: ws.name });
                let headers = []; let rows = []; let headerRowIndex = -1;
                let columnStyles = {}; 
                let colMaxLengths = {};
                /* _dateOriginals[rowIdx] = { colName: Date, ... } | null
                   Guardamos el Date original de cada celda fecha para poder reformatear
                   en vivo cuando el usuario cambie pptDateFormat sin tener que volver a
                   cargar el Excel. Solo se llena para columnas con celdas Date. */
                let dateOriginals = []; 

                /* includeEmpty: columnas virtuales / celdas en blanco: sin esto ExcelJS omitía huecos y desalineaba cabeceras con datos por fila. */
                ws.eachRow({ includeEmpty: true }, (row, rowNum) => { let validCellsCount = 0; row.eachCell({ includeEmpty: true }, (c) => { if (c.value) validCellsCount++; }); if (validCellsCount > 1 && headerRowIndex === -1 && rowNum <= 5) headerRowIndex = rowNum; });
                if (headerRowIndex === -1) headerRowIndex = 1;

                ws.eachRow({ includeEmpty: true }, (row, rowNum) => {
                    if (rowNum === headerRowIndex) {
                        row.eachCell({ includeEmpty: true }, (cell, colNum) => { 
                            let colName = (cell.text || cell.value?.toString() || `Col${colNum}`).trim();
                            headers[colNum] = colName; 
                            colMaxLengths[colName] = colName.length; 
                        });
                    } else if (rowNum > headerRowIndex) {
                        const rData = {};
                        /* Mapa de Date originales por columna (solo para celdas que SON fechas).
                           Si la fila no tiene fechas, queda null para ahorrar memoria. */
                        let rowDates = null;
                        row.eachCell({ includeEmpty: true }, (cell, colNum) => { 
                            let colName = headers[colNum];
                            if(colName) {
                                let valStr = '';
                                /* Resolver el Date efectivo de la celda (puede venir como Date directo
                                   o como resultado de fórmula). Guardamos el Date original para
                                   poder reformatear en vivo si el usuario cambia pptDateFormat. */
                                let dateObj = null;
                                if (cell.value instanceof Date) {
                                    dateObj = cell.value;
                                } else if (cell.value && typeof cell.value === 'object' && cell.value.result instanceof Date) {
                                    dateObj = cell.value.result;
                                }

                                if (cell.value !== null && cell.value !== undefined) {
                                    if (dateObj) {
                                        /* Fecha: aplicar formato global configurado. */
                                        valStr = this.formatDateAsMode(dateObj, this.pptDateFormat);
                                        if (!rowDates) rowDates = {};
                                        rowDates[colName] = dateObj;
                                    } else if (typeof cell.value === 'object' && cell.value.result !== undefined) {
                                        /* Fórmula (no fecha): usar el resultado. */
                                        valStr = String(cell.value.result);
                                    } else {
                                        /* Caso especial: Salesforce Reports API entrega columnas de fecha
                                           como strings ISO ya formateados (p.ej. "2026-05-04"). ExcelJS los
                                           ve como string puro, no como Date. Si detectamos un formato
                                           INEQUÍVOCO (año al inicio), lo parseamos y aplicamos pptDateFormat.
                                           Si es ambiguo (1/2/2026), lo dejamos tal cual para no romperlo. */
                                        const rawStr = (cell.text || String(cell.value)).trim();
                                        const parsed = this.tryParseUnambiguousDate(rawStr);
                                        if (parsed) {
                                            valStr = this.formatDateAsMode(parsed, this.pptDateFormat);
                                            if (!rowDates) rowDates = {};
                                            rowDates[colName] = parsed;
                                        } else {
                                            valStr = rawStr;
                                        }
                                    }
                                }
                                rData[colName] = valStr; 
                                if (valStr.length > colMaxLengths[colName]) {
                                    colMaxLengths[colName] = valStr.length;
                                }
                            }
                        });
                        rows.push(rData);
                        dateOriginals.push(rowDates);
                    }
                });

                /* Bordes detectados a nivel hoja. Capturamos uno representativo del
                   header y uno del primer dato. Si la hoja viene de reporteKaufmann,
                   estos bordes son globales (config "Bordes" en la pestaña Formato),
                   por lo que con una muestra alcanza. La primera detección no nula
                   se usa como tableBorder y se aplica a todas las tablas del PPT
                   construidas a partir de esa hoja. */
                let tableHeaderBorder = null;
                let tableDataBorder = null;

                ws.eachRow({ includeEmpty: true }, (row, rowNum) => {
                    if (rowNum === headerRowIndex) {
                        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
                            let colName = headers[colNum];
                            let baseWidth = ws.getColumn(colNum).width;
                            if (!baseWidth || baseWidth <= 18) {
                                let maxLen = colMaxLengths[colName] || 15;
                                baseWidth = Math.min(80, Math.max(15, maxLen * 0.65));
                            }
                            let headFill = (cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb) ? getPptColor(cell.fill.fgColor.argb) : null;
                            let headColor = (cell.font && cell.font.color && cell.font.color.argb) ? getPptColor(cell.font.color.argb) : null;
                            if (!tableHeaderBorder) {
                                tableHeaderBorder = mapExcelBorderToPptx(cell.border);
                            }
                            columnStyles[colName] = { width: baseWidth, headFill, headColor, dataFill: null, dataColor: null };
                        });
                    } else if (rowNum === headerRowIndex + 1) {
                        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
                            let colName = headers[colNum];
                            if (columnStyles[colName]) {
                                columnStyles[colName].dataFill = (cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb) ? getPptColor(cell.fill.fgColor.argb) : null;
                                columnStyles[colName].dataColor = (cell.font && cell.font.color && cell.font.color.argb) ? getPptColor(cell.font.color.argb) : null;
                            }
                            if (!tableDataBorder) {
                                tableDataBorder = mapExcelBorderToPptx(cell.border);
                            }
                        });
                    }
                });

                /* Priorizamos el borde de las filas de datos (es lo que más se ve);
                   si no hay info en datos, caemos al del header. Si tampoco hay,
                   queda null y la generación PPT usará su fallback gris. */
                const tableBorder = tableDataBorder || tableHeaderBorder || null;

                const cleanHeaders = headers.filter((h) => h !== undefined);
                rows.forEach((rowObj) => {
                    cleanHeaders.forEach((col) => {
                        if (!Object.prototype.hasOwnProperty.call(rowObj, col)) rowObj[col] = '';
                    });
                });

                this.parsedExcelData[ws.name] = {
                    headers: cleanHeaders,
                    rows,
                    allColumns: cleanHeaders.map((h) => ({ label: h, value: h })),
                    columnStyles,
                    /* Date originales por fila. Permite reformatear fechas en vivo cuando
                       el usuario cambia pptDateFormat sin tener que volver a cargar el Excel. */
                    _dateOriginals: dateOriginals,
                    /* Borde detectado en el Excel (estilo, color y grosor). Si null,
                       la generación PPT usa su default gris claro. Estructura
                       compatible con pptxgenjs: objeto único {type,color,pt} o
                       array de 4 lados [top,right,bottom,left]. */
                    tableBorder
                };
            });
            this.parsingStatusText = 'Cargando configuración de presentación...';

            let loaded = false;
            if (this.reportId) loaded = await this.loadSavedPptConfig();
            if (!loaded && this.hasLocalBackup) {
                this.parsingStatusText = 'Restaurando respaldo local...';
                await this.restoreFromLocalBackup();
            }

            // AUTO-SANACIÓN (AUTO-HEAL): Previene tablas vacías si cambió el nombre de la hoja en el Excel.
            if (this.slidesConfig && this.slidesConfig.length > 0) {
                const validSheets = this.sheetOptions.map(opt => opt.value);
                let configUpdated = false;
                
                const healTableRow = (t, currentSheet) => {
                    let allCols = this.parsedExcelData?.[currentSheet]?.allColumns || [];
                    let colOptions = [{ label: 'Sin Filtro', value: 'TODOS' }, ...allCols];
                    const nt = this.normalizeTableChartConfig({ ...t, sheetName: currentSheet, columnOptions: colOptions });
                    const sd = this.parsedExcelData?.[currentSheet];
                    if (this.isPivotBlock(nt)) {
                        this.ensurePivotColumnDefaults(nt, sd);
                    } else {
                        this.ensureChartColumnDefaults(nt);
                    }
                    return nt;
                };

                const healedSlides = this.slidesConfig.map(s => {
                    let updatedTables = (s.tables || []).map(t => {
                        let currentSheet = t.sheetName;
                        if (!validSheets.includes(currentSheet)) {
                            currentSheet = validSheets.length > 0 ? validSheets[0] : '';
                            configUpdated = true;
                        }
                        return healTableRow(t, currentSheet);
                    });
                    return { ...s, tables: updatedTables };
                });

                if (configUpdated) {
                    this.slidesConfig = healedSlides;
                }

                this.slidesConfig = this.slidesConfig.map(s => ({
                    ...s,
                    tables: (s.tables || []).map(t => healTableRow(t, t.sheetName))
                }));
                
                this.slidesConfig.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
            } else {
                this.addSlide();
            }

            this.ensurePresentationEnvelopeSeeded();
            this.syncPresentationLabelDraft();
            /* Baseline para Undo/Redo: el estado tras cargar (o crear) la config inicial. */
            this._resetUndoBaseline();
            
        } catch (e) { console.error(e); this.showToast('Error', 'Error procesando el Excel.', 'error'); } finally { this.parsingStatusText = 'Extrayendo datos y estilos del Excel...'; this.isParsingExcel = false; }
    }

    addSlide() {
        const slide = { id: `slide_${Date.now()}`, title: 'Nueva Diapositiva', subtitle: '', tables: [], excludeFromExport: false, speakerNotes: '', logoBase64: '', logoMime: '', logoCorner: 'top-right', logoSizePct: 12 };
        this.slidesConfig = [...this.slidesConfig, slide];
        this.addTableToSlide(this.slidesConfig.length - 1);
        this._captureUndoSnapshot();
    }

    addEmptySlide() {
        const slide = { id: `slide_${Date.now()}`, title: 'Nueva Diapositiva', subtitle: '', tables: [], excludeFromExport: false, speakerNotes: '', logoBase64: '', logoMime: '', logoCorner: 'top-right', logoSizePct: 12 };
        this.slidesConfig = [...this.slidesConfig, slide];
        this._captureUndoSnapshot();
    }

    handleSlideNotesChange(event) {
        const slideIdx = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(slideIdx) || slideIdx < 0 || slideIdx >= this.slidesConfig.length) return;
        const value = event.target.value || '';
        this.slidesConfig = this.slidesConfig.map((s, i) => i === slideIdx ? { ...s, speakerNotes: value } : s);
    }

    /* === Logo por slide ===
       Guardamos el archivo como dataURL base64 inline en la config para evitar tener que subirlo
       a Salesforce Files. Limitamos el tamano a 150KB para no inflar el Long Text del registro. */
    async handleSlideLogoFile(event) {
        const slideIdx = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(slideIdx) || slideIdx < 0 || slideIdx >= this.slidesConfig.length) return;
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const MAX_BYTES = 150 * 1024;
        if (file.size > MAX_BYTES) {
            this.showToast('Logo demasiado grande', `El archivo supera ${Math.round(MAX_BYTES/1024)} KB (subiste ${Math.round(file.size/1024)} KB). Usa un PNG/JPG comprimido.`, 'warning');
            event.target.value = null;
            return;
        }
        const mime = (file.type || '').toLowerCase();
        if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(mime)) {
            this.showToast('Formato no soportado', 'Sube una imagen PNG, JPG, WebP, GIF o SVG.', 'warning');
            event.target.value = null;
            return;
        }
        try {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            this.slidesConfig = this.slidesConfig.map((s, i) => i === slideIdx ? { ...s, logoBase64: dataUrl, logoMime: mime } : s);
            this.showToast('Logo cargado', 'Se aplicara a las diapositivas fisicas de este slide en el PPT.', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('Error', 'No se pudo leer la imagen.', 'error');
        } finally {
            /* Reseteamos el input para permitir re-subir el mismo archivo. */
            event.target.value = null;
        }
    }

    removeSlideLogo(event) {
        const slideIdx = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(slideIdx) || slideIdx < 0 || slideIdx >= this.slidesConfig.length) return;
        this.slidesConfig = this.slidesConfig.map((s, i) => i === slideIdx ? { ...s, logoBase64: '', logoMime: '' } : s);
    }

    handleSlideLogoCornerChange(event) {
        const slideIdx = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(slideIdx) || slideIdx < 0 || slideIdx >= this.slidesConfig.length) return;
        const v = event.detail?.value || event.target?.value || 'top-right';
        this.slidesConfig = this.slidesConfig.map((s, i) => i === slideIdx ? { ...s, logoCorner: v } : s);
    }

    handleSlideLogoSizeChange(event) {
        const slideIdx = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(slideIdx) || slideIdx < 0 || slideIdx >= this.slidesConfig.length) return;
        const v = Number(event.detail?.value ?? event.target?.value) || 12;
        const clamped = Math.max(5, Math.min(40, v));
        this.slidesConfig = this.slidesConfig.map((s, i) => i === slideIdx ? { ...s, logoSizePct: clamped } : s);
    }

    get logoCornerOptions() {
        return [
            { label: 'Sup. izquierda', value: 'top-left' },
            { label: 'Sup. derecha', value: 'top-right' },
            { label: 'Inf. izquierda', value: 'bottom-left' },
            { label: 'Inf. derecha', value: 'bottom-right' }
        ];
    }

    get logoSizeOptions() {
        return [
            { label: 'Pequeño (8%)', value: '8' },
            { label: 'Mediano (12%)', value: '12' },
            { label: 'Grande (18%)', value: '18' },
            { label: 'XL (25%)', value: '25' }
        ];
    }

    moveSlideUp(event) {
        const i = Number(event.currentTarget.dataset.spos);
        if (i <= 0) return;
        const slides = [...this.slidesConfig];
        [slides[i - 1], slides[i]] = [slides[i], slides[i - 1]];
        this.slidesConfig = slides;
        this._captureUndoSnapshot();
    }

    moveSlideDown(event) {
        const i = Number(event.currentTarget.dataset.spos);
        if (i >= this.slidesConfig.length - 1) return;
        const slides = [...this.slidesConfig];
        [slides[i], slides[i + 1]] = [slides[i + 1], slides[i]];
        this.slidesConfig = slides;
        this._captureUndoSnapshot();
    }

    /* === Drag & Drop entre diapositivas ===
       El usuario arrastra el icono utility:drag_and_drop de un slide y lo suelta sobre el
       header de otro slide para reordenar. _dragSrcSlideIdx guarda el indice de origen
       durante el drag (no usamos dataTransfer puro porque setData puede ser bloqueado por
       lightning-accordion-section en algunos navegadores). */
    onSlideDragStart(event) {
        const i = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(i)) return;
        this._dragSrcSlideIdx = i;
        try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(i));
        } catch (_) { /* algunos navegadores restringen setData en shadow DOM */ }
    }

    onSlideDragOver(event) {
        if (this._dragSrcSlideIdx == null) return;
        event.preventDefault();
        try { event.dataTransfer.dropEffect = 'move'; } catch (_) { /* noop */ }
        const host = event.currentTarget;
        if (host && !host.classList.contains('slide-actions-slot--dragover')) {
            host.classList.add('slide-actions-slot--dragover');
        }
    }

    onSlideDragLeave(event) {
        const host = event.currentTarget;
        host?.classList.remove('slide-actions-slot--dragover');
    }

    onSlideDrop(event) {
        event.preventDefault();
        const host = event.currentTarget;
        host?.classList.remove('slide-actions-slot--dragover');
        const targetIdx = Number(host?.dataset?.spos);
        const srcIdx = this._dragSrcSlideIdx;
        this._dragSrcSlideIdx = null;
        if (Number.isNaN(targetIdx) || srcIdx == null || srcIdx === targetIdx) return;
        if (srcIdx < 0 || srcIdx >= this.slidesConfig.length) return;
        if (targetIdx < 0 || targetIdx >= this.slidesConfig.length) return;
        const slides = [...this.slidesConfig];
        const [moved] = slides.splice(srcIdx, 1);
        slides.splice(targetIdx, 0, moved);
        this.slidesConfig = slides;
        this._captureUndoSnapshot();
    }

    onSlideDragEnd() {
        /* Cleanup defensivo si soltamos fuera de cualquier drop zone. */
        this._dragSrcSlideIdx = null;
        const all = this.template.querySelectorAll('.slide-actions-slot--dragover');
        all && all.forEach((el) => el.classList.remove('slide-actions-slot--dragover'));
    }

    async removeSlide(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const sIndex = Number(event.currentTarget.dataset.spos ?? event.currentTarget.dataset.sindex);
        if (Number.isNaN(sIndex) || sIndex < 0 || sIndex >= this.slidesConfig.length) return;
        const slide = this.slidesConfig[sIndex];
        const title = slide?.title || `Diapositiva ${sIndex + 1}`;
        const ok = await this.confirmDeletion(
            `¿Eliminar la diapositiva «${title}» y todos sus bloques?`,
            'Eliminar diapositiva'
        );
        if (!ok) return;
        const copy = [...this.slidesConfig];
        copy.splice(sIndex, 1);
        this.slidesConfig = copy;
        this._captureUndoSnapshot();
    }

    cloneTableDeep(t) {
        const raw = JSON.parse(JSON.stringify(t));
        raw.id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        if (raw.filters?.length) {
            raw.filters = raw.filters.map((f) => ({
                ...f,
                id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
            }));
        }
        return this.normalizeTableChartConfig(raw);
    }

    cloneSlideDeep(slide) {
        const s = JSON.parse(JSON.stringify(slide));
        s.id = `slide_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        s.tables = (slide.tables || []).map((tb) => this.cloneTableDeep(tb));
        return s;
    }

    duplicateSlide(event) {
        const i = Number(event.currentTarget.dataset.spos);
        if (Number.isNaN(i) || i < 0 || i >= this.slidesConfig.length) return;
        const copy = this.cloneSlideDeep(this.slidesConfig[i]);
        const slides = [...this.slidesConfig];
        slides.splice(i + 1, 0, copy);
        this.slidesConfig = slides;
        slides.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
        this.showToast('Duplicada', 'Copia insertada debajo de la diapositiva original.', 'success');
        this._captureUndoSnapshot();
    }

    /**
     * Mueve una diapositiva desde la variante activa a otra existente.
     * data-spos = indice slide origen, event.detail.value = id variante destino.
     */
    moveSlideToVariant(event) {
        const spos = Number(event.currentTarget.dataset.spos);
        const targetPresId = event.detail && event.detail.value;
        if (Number.isNaN(spos) || spos < 0 || spos >= this.slidesConfig.length) return;
        if (!targetPresId || targetPresId === this.activePresentationId) return;
        const target = this.pptPresentations.find((p) => p.id === targetPresId);
        if (!target) {
            this.showToast('Aviso', 'Variante destino no encontrada.', 'warning');
            return;
        }

        /* Snapshot del slide a mover y de las slides restantes en la variante activa. */
        const slideToMove = this.cloneSlideDeep(this.slidesConfig[spos]);
        const remaining = [...this.slidesConfig.slice(0, spos), ...this.slidesConfig.slice(spos + 1)];

        /* Persistimos primero las dos variantes afectadas en pptPresentations. */
        this.pptPresentations = this.pptPresentations.map((p) => {
            if (p.id === this.activePresentationId) {
                return { ...p, slidesConfig: this.sanitizeSlidesForPersist(remaining) };
            }
            if (p.id === targetPresId) {
                const dest = [...(p.slidesConfig || []), this.sanitizeSlidesForPersist([slideToMove])[0]];
                return { ...p, slidesConfig: dest };
            }
            return p;
        });

        /* La variante activa se queda sin ese slide. Mantenemos al usuario aqui (no saltamos a la destino). */
        this.slidesConfig = remaining;
        this.activeSections = [];
        remaining.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
        this.showToast('Movida', `Diapositiva enviada a la variante "${target.label || 'destino'}".`, 'success');
        this._captureUndoSnapshot();
    }

    mergeChartClipboardIntoTable(table, clip) {
        const t = this.normalizeTableChartConfig(table);
        if (!clip) return t;
        CHART_CLIP_KEYS.forEach((k) => {
            if (clip[k] !== undefined && clip[k] !== null) t[k] = clip[k];
        });
        return t;
    }

    copyChartSettingsFromBlock(event) {
        const si = Number(event.currentTarget.dataset.sindex);
        const ti = Number(event.currentTarget.dataset.tindex);
        const raw = this.slidesConfig[si]?.tables[ti];
        if (!raw) return;
        const t = this.normalizeTableChartConfig({ ...raw });
        if (this.isPivotBlock(t)) {
            this.showToast('Aviso', 'La subtabla no usa las mismas opciones que el gráfico; copia desde un bloque tabla/gráfico.', 'warning');
            return;
        }
        const clip = {};
        CHART_CLIP_KEYS.forEach((k) => {
            clip[k] = t[k];
        });
        this.chartClipboardPayload = clip;
        this.showToast('Copiado', 'Opciones de gráfico listas para pegar o propagar.', 'success');
    }

    pasteChartSettingsToBlock(event) {
        if (!this.chartClipboardPayload) {
            this.showToast('Aviso', 'Copia antes las opciones desde otro bloque (icono copiar).', 'warning');
            return;
        }
        const si = Number(event.currentTarget.dataset.sindex);
        const ti = Number(event.currentTarget.dataset.tindex);
        const slides = [...this.slidesConfig];
        const cur = this.normalizeTableChartConfig(slides[si].tables[ti]);
        if (this.isPivotBlock(cur)) {
            this.showToast('Aviso', 'No se pegan ajustes de gráfico en bloques de subtabla.', 'warning');
            return;
        }
        const merged = this.mergeChartClipboardIntoTable(slides[si].tables[ti], this.chartClipboardPayload);
        this.ensureChartColumnDefaults(merged);
        slides[si].tables[ti] = merged;
        this.slidesConfig = slides;
        this.updateTablePreview(si, ti);
        this.showToast('Pegado', 'Opciones aplicadas a este bloque.', 'success');
    }

    applyChartClipboardToAllCharts() {
        if (!this.chartClipboardPayload) {
            this.showToast('Aviso', 'Copia antes las opciones desde un bloque con gráfico.', 'warning');
            return;
        }
        let count = 0;
        const slides = this.slidesConfig.map((slide) => {
            const tables = (slide.tables || []).map((tb) => {
                const nt = this.normalizeTableChartConfig(tb);
                if (this.isPivotBlock(nt)) return nt;
                if (!nt.hasChart && !this.isChartSoloBlock(nt)) return nt;
                const merged = this.mergeChartClipboardIntoTable(nt, this.chartClipboardPayload);
                this.ensureChartColumnDefaults(merged);
                count++;
                return merged;
            });
            return { ...slide, tables };
        });
        this.slidesConfig = slides;
        slides.forEach((s, si) => (s.tables || []).forEach((t, ti) => this.updateTablePreview(si, ti)));
        this.showToast('Propagado', `Opciones aplicadas a ${count} bloque(s) con gráfico.`, 'success');
    }

    validateExportConfiguration() {
        const errors = [];
        const warnings = [];
        if (!this.pptxLoaded) errors.push('El motor de exportación no está listo.');
        if (!this.selectedDesign) errors.push('Selecciona una plantilla corporativa.');
        if (!this.slidesConfig?.length) errors.push('Añade al menos una diapositiva de contenido.');
        if (this.slidesConfig?.length && this.exportableSlideCount === 0) {
            errors.push('Todas las diapositivas están excluidas de la descarga; activa al menos una.');
        }
        this.slidesConfig.forEach((slide, si) => {
            if (slide.excludeFromExport) return;
            const sn = si + 1;
            if (!(slide.tables || []).length) {
                warnings.push(`Diapositiva ${sn} no tiene bloques; se exportará solo con título/subtítulo.`);
            }
            (slide.tables || []).forEach((tb, ti) => {
                const t = this.normalizeTableChartConfig(tb);
                const bn = ti + 1;
                const sheet = (t.sheetName || '').trim();
                if (!sheet) errors.push(`Diap. ${sn}, bloque ${bn}: elige la hoja Excel.`);
                else if (!this.parsedExcelData?.[sheet]) errors.push(`Diap. ${sn}, bloque ${bn}: la hoja «${sheet}» no existe en el archivo cargado.`);
                if (this.isPivotBlock(t)) {
                    const sd = this.parsedExcelData?.[sheet];
                    this.ensurePivotColumnDefaults(t, sd);
                    const agg = (t.pivotAggregation || 'sum').toLowerCase();
                    if (!(t.pivotGroupColumn || '').trim()) errors.push(`Diap. ${sn}, bloque ${bn}: subtabla — elige columna de agrupación.`);
                    if (agg !== 'count' && !(t.pivotValueColumn || '').trim()) {
                        errors.push(`Diap. ${sn}, bloque ${bn}: subtabla — elige columna de medida.`);
                    }
                    return;
                }
                const cols = t.selectedColumns || [];
                if (!cols.length) errors.push(`Diap. ${sn}, bloque ${bn}: selecciona columnas.`);
                const needsChart = t.hasChart || this.isChartSoloBlock(t);
                if (needsChart) {
                    this.ensureChartColumnDefaults(t);
                    if (!t.chartCategoryColumn || !t.chartValueColumn) {
                        errors.push(`Diap. ${sn}, bloque ${bn}: indica columnas categoría y valor para el gráfico.`);
                    }
                }
            });
        });
        return { valid: errors.length === 0, errors, warnings };
    }

    handleSlideInput(event) {
        const sIndex = Number(event.currentTarget.dataset.sindex);
        const field = event.currentTarget.dataset.field;
        const slides = [...this.slidesConfig];
        slides[sIndex] = { ...slides[sIndex], [field]: event.target.value };
        this.slidesConfig = slides;
    }

    handleSlideExportToggle(event) {
        const raw = event.currentTarget?.dataset?.spos ?? event.target?.dataset?.spos;
        const i = Number(raw);
        if (Number.isNaN(i) || i < 0 || i >= this.slidesConfig.length) return;
        const checked = !!event.detail.checked;
        const slides = [...this.slidesConfig];
        slides[i] = { ...slides[i], excludeFromExport: !checked };
        this.slidesConfig = slides;
    }

    addTableToSlide(eventOrIndex) {
        const sIndex = typeof eventOrIndex === 'object'
            ? Number(eventOrIndex.currentTarget.dataset.spos ?? eventOrIndex.currentTarget.dataset.sindex)
            : Number(eventOrIndex);
        const sheet = this.sheetOptions.length ? this.sheetOptions[0].value : '';
        const allCols = this.parsedExcelData?.[sheet]?.allColumns || [];
        const table = this.normalizeTableChartConfig({
            id: `tab_${Date.now()}`,
            sheetName: sheet,
            selectedColumns: allCols.map(c => c.value),
            columnOptions: [{ label: 'Sin Filtro', value: 'TODOS' }, ...allCols],
            filters: [],
            hasChart: false,
            chartType: 'bar',
            tableAlign: 'left',
            previewHeaders: [],
            previewRows: []
        });
        this.ensureChartColumnDefaults(table);
        const slides = [...this.slidesConfig];
        slides[sIndex].tables = [...slides[sIndex].tables, table];
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, slides[sIndex].tables.length - 1);
    }

    addChartOnlyBlock(event) {
        const sIndex = typeof event.currentTarget.dataset.spos !== 'undefined'
            ? Number(event.currentTarget.dataset.spos)
            : Number(event.currentTarget.dataset.sindex);
        const sheet = this.sheetOptions.length ? this.sheetOptions[0].value : '';
        const allCols = this.parsedExcelData?.[sheet]?.allColumns || [];
        const table = this.normalizeTableChartConfig({
            id: `tab_${Date.now()}`,
            sheetName: sheet,
            selectedColumns: allCols.map(c => c.value),
            columnOptions: [{ label: 'Sin Filtro', value: 'TODOS' }, ...allCols],
            filters: [],
            hasChart: true,
            chartPosition: 'solo',
            chartType: 'bar',
            tableAlign: 'center',
            previewHeaders: [],
            previewRows: []
        });
        this.ensureChartColumnDefaults(table);
        const slides = [...this.slidesConfig];
        slides[sIndex].tables = [...slides[sIndex].tables, table];
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, slides[sIndex].tables.length - 1);
    }

    addPivotBlock(event) {
        const sIndex = typeof event.currentTarget.dataset.spos !== 'undefined'
            ? Number(event.currentTarget.dataset.spos)
            : Number(event.currentTarget.dataset.sindex);
        const sheet = this.sheetOptions.length ? this.sheetOptions[0].value : '';
        const allCols = this.parsedExcelData?.[sheet]?.allColumns || [];
        const sheetData = this.parsedExcelData?.[sheet];
        const table = this.normalizeTableChartConfig({
            id: `tab_${Date.now()}`,
            blockType: 'pivot',
            sheetName: sheet,
            selectedColumns: [],
            columnOptions: [{ label: 'Sin Filtro', value: 'TODOS' }, ...allCols],
            filters: [],
            hasChart: false,
            chartType: 'bar',
            tableAlign: 'left',
            pivotShowTotal: false,
            previewHeaders: [],
            previewRows: []
        });
        this.ensurePivotColumnDefaults(table, sheetData);
        const slides = [...this.slidesConfig];
        slides[sIndex].tables = [...slides[sIndex].tables, table];
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, slides[sIndex].tables.length - 1);
    }

    async removeTableFromSlide(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const sIndex = Number(event.currentTarget.dataset.sindex);
        const tIndex = Number(event.currentTarget.dataset.tindex);
        const ok = await this.confirmDeletion(
            '¿Eliminar este bloque (tabla, subtabla o solo gráfico)?',
            'Eliminar bloque'
        );
        if (!ok) return;
        const slides = [...this.slidesConfig];
        slides[sIndex].tables = [...slides[sIndex].tables];
        slides[sIndex].tables.splice(tIndex, 1);
        this.slidesConfig = slides;
    }

    handleTableInput(event) {
        const sIndex = Number(event.currentTarget.dataset.sindex);
        const tIndex = Number(event.currentTarget.dataset.tindex);
        const field = event.currentTarget.dataset.field;
        const slides = [...this.slidesConfig];
        const table = this.normalizeTableChartConfig({ ...slides[sIndex].tables[tIndex] });

        let value;
        if (event.detail && typeof event.detail.checked === 'boolean') {
            value = event.detail.checked;
        } else if (event.target && (event.target.type === 'checkbox' || event.target.type === 'toggle')) {
            value = event.target.checked;
        } else if (event.detail && event.detail.value !== undefined) {
            value = event.detail.value;
        } else if (event.target) {
            value = event.target.value;
        }

        /* Normalización para el override numérico de filas por slide: aceptamos
           vacío (= auto), número entero positivo. Cualquier otra cosa la
           dejamos como null para que el cálculo automático tome el control. */
        if (field === 'maxRowsPerSlideOverride') {
            const raw = value;
            if (raw === '' || raw === null || raw === undefined) {
                value = null;
            } else {
                const n = Number(raw);
                value = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
            }
        }

        table[field] = value;

        if (this.isPivotBlock(table)) {
            if (field === 'sheetName') {
                const allCols = this.parsedExcelData?.[table.sheetName]?.allColumns || [];
                table.selectedColumns = [];
                table.columnOptions = [{ label: 'Sin Filtro', value: 'TODOS' }, ...allCols];
                table.filters = [];
            }
            const sheetData = this.parsedExcelData?.[table.sheetName];
            this.ensurePivotColumnDefaults(table, sheetData);
            slides[sIndex].tables[tIndex] = table;
            this.slidesConfig = slides;
            this.updateTablePreview(sIndex, tIndex);
            return;
        }

        if (field === 'chartPosition' && value === 'solo') {
            table.hasChart = true;
        }

        if (field === 'sheetName') {
            const allCols = this.parsedExcelData?.[table.sheetName]?.allColumns || [];
            table.selectedColumns = allCols.map(c => c.value);
            table.columnOptions = [{label: 'Sin Filtro', value: 'TODOS'}, ...allCols];
            table.filters = [];
        }

        if (field === 'hasChart' && value === true) {
            this.ensureChartColumnDefaults(table);
        }

        this.ensureChartColumnDefaults(table);
        slides[sIndex].tables[tIndex] = table;
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, tIndex);
    }

    addFilter(event) {
        const sIndex = Number(event.currentTarget.dataset.sindex); const tIndex = Number(event.currentTarget.dataset.tindex);
        let slides = [...this.slidesConfig]; let table = {...slides[sIndex].tables[tIndex]};
        table.filters = [...table.filters, { id: 'f_' + Date.now(), column: 'TODOS', operator: 'eq', value: 'TODOS', value2: '', valueOptions: [{label: 'Todos', value: 'TODOS'}], disableVal: true }];
        slides[sIndex].tables[tIndex] = table; this.slidesConfig = slides;
    }

    async removeFilter(event) {
        const sIndex = Number(event.currentTarget.dataset.sindex);
        const tIndex = Number(event.currentTarget.dataset.tindex);
        const fIndex = Number(event.currentTarget.dataset.findex);
        const ok = await this.confirmDeletion('¿Quitar este filtro del bloque?', 'Quitar filtro');
        if (!ok) return;
        let slides = [...this.slidesConfig];
        let table = { ...slides[sIndex].tables[tIndex] };
        table.filters = [...table.filters];
        table.filters.splice(fIndex, 1);
        slides[sIndex].tables[tIndex] = table;
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, tIndex);
    }

    handleFilterChange(event) {
        const sIndex = Number(event.currentTarget.dataset.sindex); const tIndex = Number(event.currentTarget.dataset.tindex); const fIndex = Number(event.currentTarget.dataset.findex);
        const field = event.currentTarget.dataset.field;
        let slides = [...this.slidesConfig]; let table = {...slides[sIndex].tables[tIndex]}; let filter = {...table.filters[fIndex]};
        /* Para filtros legacy sin 'operator', persistimos su operador efectivo ('eq') antes del cambio. */
        if (!filter.operator) filter.operator = resolveFilterOperator(filter);
        filter[field] = event.detail !== undefined && event.detail.value !== undefined ? event.detail.value : event.target.value;
        if (field === 'column') {
            /* Al cambiar columna reseteamos el operador a 'eq' para evitar que un operador
               numérico (between, gt, etc.) quede aplicado a una columna texto y filtre
               silenciosamente todas las filas. Si el usuario quiere otro operador lo
               selecciona explícitamente. */
            filter.operator = 'eq';
            filter.value = 'TODOS'; filter.value2 = ''; filter.valueOptions = [{label: 'Todos', value: 'TODOS'}];
            if (filter.column !== 'TODOS') {
                let sheetData = this.parsedExcelData[table.sheetName];
                let uniqueVals = new Set();
                if(sheetData) {
                    sheetData.rows.forEach(r => { if(r[filter.column]) uniqueVals.add(r[filter.column]); });
                    Array.from(uniqueVals).sort().forEach(v => filter.valueOptions.push({label: v, value: v}));
                }
                filter.disableVal = false;
            } else filter.disableVal = true;
        }
        if (field === 'operator') {
            const spec = FILTER_OPERATOR_MAP[filter.operator] || FILTER_OPERATOR_MAP.eq;
            /* Si el operador nuevo no requiere valor, lo limpiamos; si no es 'between', vaciamos value2. */
            if (!spec.needsValue) {
                filter.value = '';
                filter.value2 = '';
            } else if (spec.value !== 'between') {
                filter.value2 = '';
            }
        }
        table.filters[fIndex] = filter; slides[sIndex].tables[tIndex] = table; this.slidesConfig = slides;
        this.updateTablePreview(sIndex, tIndex);
    }

    updateTablePreview(sIndex, tIndex) {
        const slides = [...this.slidesConfig];
        const table = this.normalizeTableChartConfig({ ...slides[sIndex].tables[tIndex] });
        const sheetData = this.parsedExcelData?.[table.sheetName];
        if (!sheetData) return;
        let filteredRows = sheetData.rows;
        (table.filters || []).forEach(f => {
            if (isFilterUsableAdvanced(f)) {
                filteredRows = filteredRows.filter(r => applyBlockFilter(r[f.column], f));
            }
        });
        const allColOpts = (sheetData.allColumns || []).map((c) => ({ label: c.label, value: c.value }));
        table.pivotGroupOptions = allColOpts;
        table.pivotValueOptions = allColOpts;

        if (this.isPivotBlock(table)) {
            this.ensurePivotColumnDefaults(table, sheetData);
            const {
                agg,
                g,
                labels,
                values
            } = this.finalizePivotAggregation(filteredRows, table);
            table.pivotMeasureDisabled = agg === 'count';
            const hCat = g || '—';
            const hVal = this.pivotMetricHeaderLabel(table);
            const orient = table.pivotOrientation === 'horizontal' ? 'horizontal' : 'vertical';

            let previewRows = [];
            let previewHeaderCells = [];

            if (orient === 'vertical') {
                previewRows = labels.map((lb, i) => ({
                    id: `ppr_${i}`,
                    cells: [
                        { id: `ppc_${i}_0`, value: lb },
                        { id: `ppc_${i}_1`, value: this.formatPivotMetricDisplay(table, values[i], i) }
                    ]
                }));
                if (table.pivotShowTotal && labels.length) {
                    let tot;
                    if (agg === 'avg') {
                        const s = values.reduce((a, b) => a + (Number(b) || 0), 0);
                        tot = s / values.length;
                    } else {
                        tot = values.reduce((a, b) => a + (Number(b) || 0), 0);
                    }
                    previewRows = [
                        ...previewRows,
                        {
                            id: 'ppr_total',
                            cells: [
                                { id: 'ppc_tot_0', value: 'Total' },
                                { id: 'ppc_tot_1', value: this.formatPivotMetricDisplay(table, tot, -1) }
                            ]
                        }
                    ];
                }
                previewHeaderCells = [
                    { id: 'mph_v0', label: hCat },
                    { id: 'mph_v1', label: hVal }
                ];
            } else {
                previewHeaderCells = [
                    { id: 'mph_hz_corner', label: hCat },
                    ...labels.map((lb, i) => ({ id: `mph_hz_${i}`, label: String(lb) }))
                ];
                const cells = [{ id: 'mph_hz_m0', value: hVal }];
                labels.forEach((_lb, i) => {
                    cells.push({ id: `mph_hz_mv_${i}`, value: this.formatPivotMetricDisplay(table, values[i], i) });
                });
                if (table.pivotShowTotal && labels.length) {
                    previewHeaderCells.push({ id: 'mph_hz_totcol', label: 'Total' });
                    let tot;
                    if (agg === 'avg') {
                        const s = values.reduce((a, b) => a + (Number(b) || 0), 0);
                        tot = s / values.length;
                    } else {
                        tot = values.reduce((a, b) => a + (Number(b) || 0), 0);
                    }
                    cells.push({ id: 'mph_hz_mtot', value: this.formatPivotMetricDisplay(table, tot, -1) });
                }
                previewRows = [{ id: 'ppr_horiz', cells }];
            }

            table.previewHeaderCells = previewHeaderCells;
            table.previewHeaders = [];
            table.previewRows = previewRows;
            table.chartCategoryOptions = allColOpts;
            table.chartValueOptions = allColOpts;
            table.chartPreviewModel = null;
            table.chartSolo = false;
            table.isPivotBlock = true;
            table.selectedColumnOrderHints = [];
            table.configBoxClass = 'table-config-box table-config-box--pivot';
            slides[sIndex].tables = [...slides[sIndex].tables];
            slides[sIndex].tables[tIndex] = table;
            this.slidesConfig = slides;
            return;
        }

        this.ensureChartColumnDefaults(table);
        table.chartCategoryOptions = (table.selectedColumns || []).map(c => ({ label: c, value: c.trim() }));
        table.chartValueOptions = (table.selectedColumns || []).map(c => ({ label: c, value: c.trim() }));
        table.previewHeaderCells = [];
        table.previewHeaders = [...(table.selectedColumns || [])];
        table.previewRows = filteredRows.slice(0, 3).map((r, i) => ({ 
            id: `pr_${i}`, 
            cells: (table.selectedColumns || []).map((h, j) => {
                let safeH = h.trim();
                let val = r[safeH];
                if (val === undefined) val = r[h];
                let cellVal = (val !== null && val !== undefined && val !== '') ? String(val) : '-';
                return { id: `pc_${i}_${j}`, value: cellVal };
            }) 
        }));
        table.chartPreviewModel = table.hasChart ? this.buildChartSeriesModel(table, filteredRows) : null;
        table.chartSolo = this.isChartSoloBlock(table);
        table.isPivotBlock = false;
        table.pivotMeasureDisabled = false;
        table.configBoxClass = table.chartSolo ? 'table-config-box table-config-box--solo-chart' : 'table-config-box';
        const ordCols = table.selectedColumns || [];
        const ordIdBase = table.id || `slide${sIndex}_blk${tIndex}`;
        table.selectedColumnOrderHints = ordCols.map((columnName, oidx) => ({
            col: columnName,
            uid: `${ordIdBase}_${oidx}_${String(columnName).replace(/\s+/g, '_')}`,
            moveUpDisabled: oidx === 0,
            moveDownDisabled: oidx >= ordCols.length - 1
        }));
        slides[sIndex].tables = [...slides[sIndex].tables];
        slides[sIndex].tables[tIndex] = table;
        this.slidesConfig = slides;
    }

    moveTableColumnStep(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const sIndex = Number(event.currentTarget.dataset.sindex);
        const tIndex = Number(event.currentTarget.dataset.tindex);
        const col = event.currentTarget.dataset.col;
        const dir = Number(event.currentTarget.dataset.dir);
        if (!Number.isFinite(sIndex) || !Number.isFinite(tIndex) || col === undefined || !Number.isFinite(dir)) return;
        const slides = [...this.slidesConfig];
        const table = this.normalizeTableChartConfig({ ...slides[sIndex].tables[tIndex] });
        if (this.isPivotBlock(table)) return;
        const cols = [...(table.selectedColumns || [])];
        const idx = cols.findIndex((c) => String(c) === String(col));
        if (idx < 0) return;
        const j = idx + dir;
        if (j < 0 || j >= cols.length) return;
        [cols[idx], cols[j]] = [cols[j], cols[idx]];
        table.selectedColumns = cols;
        this.ensureChartColumnDefaults(table);
        slides[sIndex].tables[tIndex] = table;
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, tIndex);
    }

    openColumnsModal(event) {
        const sIndex = Number(event.currentTarget.dataset.sindex); const tIndex = Number(event.currentTarget.dataset.tindex);
        this.columnsModalRef = { sIndex, tIndex }; const table = this.normalizeTableChartConfig(this.slidesConfig[sIndex].tables[tIndex]);
        if (this.isPivotBlock(table)) {
            this.showToast('Aviso', 'La subtabla no usa el selector de columnas: elige agrupación y medida en los desplegables del bloque.', 'info');
            return;
        }
        this.allModalOptions = this.parsedExcelData?.[table.sheetName]?.allColumns || [];
        this.modalSelectedColumns = [...(table.selectedColumns || [])];
        this.columnsSearch = ''; this.isColumnsModalOpen = true;
    }

    closeColumnsModal() { this.isColumnsModalOpen = false; }
    handleColumnsSearch(event) { this.columnsSearch = event.target.value; }
    handleModalColumnsChange(event) { this.modalSelectedColumns = event.detail.value; }
    selectAllColumns() { this.modalSelectedColumns = this.allModalOptions.map(c => c.value); }
    clearAllColumns() { this.modalSelectedColumns = []; }
    saveColumnsModal() {
        const { sIndex, tIndex } = this.columnsModalRef;
        const slides = [...this.slidesConfig];
        const table = this.normalizeTableChartConfig({ ...slides[sIndex].tables[tIndex] });
        if (this.isPivotBlock(table)) {
            this.isColumnsModalOpen = false;
            return;
        }
        table.selectedColumns = [...this.modalSelectedColumns];
        this.ensureChartColumnDefaults(table);
        slides[sIndex].tables[tIndex] = table;
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, tIndex);
        this.isColumnsModalOpen = false;
    }

    async removeColumnPill(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const sIndex = Number(event.currentTarget.dataset.sindex);
        const tIndex = Number(event.currentTarget.dataset.tindex);
        const col = event.currentTarget.dataset.col;
        const slides = [...this.slidesConfig];
        const table = this.normalizeTableChartConfig({ ...slides[sIndex].tables[tIndex] });
        if (this.isPivotBlock(table)) return;
        const ok = await this.confirmDeletion(`¿Quitar la columna «${col}» de la tabla?`, 'Quitar columna');
        if (!ok) return;
        table.selectedColumns = table.selectedColumns.filter(c => c !== col);
        this.ensureChartColumnDefaults(table);
        slides[sIndex].tables[tIndex] = table;
        this.slidesConfig = slides;
        this.updateTablePreview(sIndex, tIndex);
    }

    /**
     * PptxGenJS usa parseTextToLines al paginar tablas; si cada celda es `{ text: '...', options }` con texto
     * plano, la librería pierde opciones en los fragmentos por línea/slide siguientes (sin color de celda ni
     * cabeceras repetidas coherentes). Enviar el texto como único objeto en `text[]` preserva el estilo.
     */
    buildPptxTableStyledCell(displayText, styleOptions) {
        const txt = displayText !== null && displayText !== undefined ? String(displayText) : '';
        const opts = { breakLine: true, valign: 'top', ...styleOptions };
        return { text: [{ text: txt, options: opts }], options: opts };
    }

    async generateFinalPpt() {
        const chk = this.validateExportConfiguration();
        if (!chk.valid) {
            const msg =
                chk.errors.length <= 4
                    ? chk.errors.join(' ')
                    : `${chk.errors.slice(0, 4).join(' ')} (+${chk.errors.length - 4} más)`;
            console.warn('[reportePptBuilder] Validación exportación:', chk.errors);
            this.showToast('Revisa la configuración', msg, 'error');
            return;
        }
        if (chk.warnings?.length) {
            const wmsg =
                chk.warnings.length <= 3
                    ? chk.warnings.join(' ')
                    : `${chk.warnings.slice(0, 2).join(' ')} (+${chk.warnings.length - 2} más)`;
            this.showToast('Aviso', wmsg, 'warning');
        }

        this.isExporting = true;
        await this.updateProgress(10, 'Iniciando motor de PPT...');

        const config = this.designRecords.find(d => d.Id === this.selectedDesign);
        const primaryColor = (config?.Color_Primario__c || '#263B7A').replace('#', '').substring(0, 6);
        const secondaryColor = (config?.Color_Secundario__c || '#64748b').replace('#', '').substring(0, 6);
        const fontName = config?.Fuente_Corporativa__c || 'Calibri';
        
        let layout = { 
            slides: { 
                portada: { title: { x: 0.5, y: 3.0, w: 12.0, h: 2.5, fontSize: 32 } }, 
                contenido: { title: { x: 0.3, y: 0.2, w: 12.0, h: 0.8, fontSize: 24 }, subtitle: { x: 0.3, y: 0.8, w: 12.0, h: 0.5, fontSize: 14 }, table: { startY: 1.5 } }, 
                cierre: { title: { x: 0.5, y: 3.0, w: 12.0, h: 2.0, fontSize: 32 } } 
            } 
        };
        try { if (config?.Configuracion_JSON__c) { const parsed = JSON.parse(config.Configuracion_JSON__c); if (parsed?.slides) layout.slides = parsed.slides; } } catch (e) { console.error(e); }

        try {
            await this.updateProgress(25, 'Configurando lienzo panorámico (16:9)...');

            const pptx = new window.PptxGenJS(); 
            pptx.defineLayout({ name: 'KAUFMANN_WIDE', width: 13.33, height: 7.5 });
            pptx.layout = 'KAUFMANN_WIDE';

            const docIdsToFetch = [];
            if (layout.slides.portada.bgDocId) docIdsToFetch.push(layout.slides.portada.bgDocId);
            if (layout.slides.contenido.bgDocId) docIdsToFetch.push(layout.slides.contenido.bgDocId);
            if (layout.slides.cierre.bgDocId) docIdsToFetch.push(layout.slides.cierre.bgDocId);
            
            let imagesBase64 = {}; 
            if (docIdsToFetch.length) {
                imagesBase64 = await getBase64Images({ documentIds: docIdsToFetch });
            }
            const getImageConfig = (docId) => (docId && imagesBase64[docId]) ? { data: 'image/png;base64,' + imagesBase64[docId], x: 0, y: 0, w: '100%', h: '100%' } : null;

            await this.updateProgress(40, 'Construyendo Portadas y Master Slides...');

            if (this.includeCover) {
                const cover = pptx.addSlide(); const bg = getImageConfig(layout.slides.portada.bgDocId);
                if (bg) cover.addImage(bg); else cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: '100%', fill: { color: 'F3F4F6' } });
                const pTitle = layout.slides.portada.title;
                cover.addText(`${this.coverTitle}\n${this.formattedCoverDate}`, { x: Number(pTitle.x), y: Number(pTitle.y), w: Number(pTitle.w) || 12.0, h: Number(pTitle.h) || 2.5, color: pTitle.color ? pTitle.color.replace('#','') : primaryColor, fontSize: Number(pTitle.fontSize) || 32, fontFace: pTitle.fontFace || fontName, bold: pTitle.bold !== false, align: pTitle.align || 'center', valign: 'middle', wrap: true, shrinkText: true });
            }

            const bgContenido = getImageConfig(layout.slides.contenido.bgDocId);
            const cTitle = layout.slides.contenido.title; 
            const cSub = layout.slides.contenido.subtitle; 
            const tableStartY = Number(layout.slides.contenido.table.startY) || 1.5;

            const exportSlides = this.slidesConfig.filter((s) => !s.excludeFromExport);
            const exportTotal = exportSlides.length || 1;
            let exportBuilt = 0;

            /* Helper para superponer el logo (si existe) en cada slide PPTX fisica.
               sizePct es % del ancho del lienzo (13.33in). Usamos sizing.contain para
               respetar la proporcion del archivo sin deformarlo. */
            const SLIDE_W = 13.33; const SLIDE_H = 7.5; const MARGIN = 0.3;
            const applySlideLogo = (pptxSlide, slideDef) => {
                const data = slideDef?.logoBase64;
                if (!data || typeof data !== 'string' || !data.startsWith('data:')) return;
                const pct = Math.max(5, Math.min(40, Number(slideDef.logoSizePct) || 12));
                const wIn = (pct / 100) * SLIDE_W;
                const corner = slideDef.logoCorner || 'top-right';
                let x, y;
                switch (corner) {
                    case 'top-left':     x = MARGIN;                        y = MARGIN; break;
                    case 'bottom-left':  x = MARGIN;                        y = SLIDE_H - wIn - MARGIN; break;
                    case 'bottom-right': x = SLIDE_W - wIn - MARGIN;        y = SLIDE_H - wIn - MARGIN; break;
                    case 'top-right':
                    default:             x = SLIDE_W - wIn - MARGIN;        y = MARGIN; break;
                }
                try {
                    pptxSlide.addImage({ data, x, y, w: wIn, h: wIn, sizing: { type: 'contain', w: wIn, h: wIn } });
                } catch (err) {
                    console.warn('No se pudo insertar logo en slide:', err);
                }
            };

            /* Render del título del bloque (si existe). Devuelve el nuevo currentY desplazado.
               Si blockTitle está vacío o solo whitespace, no añade nada y deja currentY igual.
               Backward compat: bloques antiguos sin blockTitle pasan sin cambios. */
            const BLOCK_TITLE_HEIGHT = 0.32;
            const BLOCK_TITLE_GAP = 0.06;
            const renderBlockTitleIfAny = (pptxSlide, td, baseY, startX, blockWidth) => {
                const title = (td && td.blockTitle ? String(td.blockTitle).trim() : '');
                if (!title) return baseY;
                pptxSlide.addText(title, {
                    x: startX,
                    y: baseY,
                    w: blockWidth,
                    h: BLOCK_TITLE_HEIGHT,
                    fontFace: fontName,
                    fontSize: 12,
                    bold: true,
                    color: primaryColor,
                    align: 'left',
                    valign: 'middle',
                    margin: 0
                });
                return Number((baseY + BLOCK_TITLE_HEIGHT + BLOCK_TITLE_GAP).toFixed(2));
            };

            for (let i = 0; i < this.slidesConfig.length; i++) {
                const slideDef = this.slidesConfig[i];
                if (slideDef.excludeFromExport) continue;

                exportBuilt++;
                await this.updateProgress(
                    40 + Math.floor((exportBuilt / exportTotal) * 40),
                    `Construyendo diapositiva ${exportBuilt} de ${exportTotal}...`
                );

                const slideMasterName = `MASTER_SLIDE_${i}`; 

                /* Total de registros filtrados de los bloques tabla/chart de esta slide.
                   Pivots se excluyen porque su agregación no es comparable a "registros".
                   Reutilizado por el sufijo en el título y el pie opcional. */
                let slideTotalRecords = 0;
                let slideHasCountableBlocks = false;
                (slideDef.tables || []).forEach((tb) => {
                    if (tb.flagPivotBlock) return;
                    const sd = this.parsedExcelData?.[tb.sheetName];
                    if (!sd || !Array.isArray(sd.rows)) return;
                    let rows = sd.rows;
                    (tb.filters || []).forEach((f) => {
                        if (isFilterUsableAdvanced(f)) rows = rows.filter((r) => applyBlockFilter(r[f.column], f));
                    });
                    slideTotalRecords += rows.length;
                    slideHasCountableBlocks = true;
                });

                let masterObjects = [];
                if (!bgContenido) {
                    masterObjects.push({ rect: { x: 0, y: 0, w: '100%', h: 0.85, fill: { color: primaryColor } } });
                }

                /* Si showRecordCountInTitle está activo y hay bloques contables, se añade
                   " (N)" al título de la slide. Default ON. Si no hay bloques contables
                   (slide solo con pivot o vacía), no se modifica el título. */
                let effectiveSlideTitle = slideDef.title || '';
                if (this.showRecordCountInTitle && slideHasCountableBlocks && effectiveSlideTitle) {
                    effectiveSlideTitle = `${effectiveSlideTitle} (${slideTotalRecords.toLocaleString('es-CL')})`;
                }

                masterObjects.push({
                    text: {
                        text: effectiveSlideTitle,
                        options: { x: Number(cTitle.x), y: Number(cTitle.y), w: Number(cTitle.w) || 12.0, h: Number(cTitle.h) || 0.8, color: cTitle.color ? cTitle.color.replace('#','') : primaryColor, fontSize: Number(cTitle.fontSize) || 24, fontFace: cTitle.fontFace || fontName, bold: cTitle.bold !== false, align: cTitle.align || 'left', valign: 'middle' }
                    }
                });

                if (slideDef.subtitle) {
                    masterObjects.push({
                        text: {
                            text: slideDef.subtitle,
                            options: { x: Number(cSub.x), y: Number(cSub.y), w: Number(cSub.w) || 12.0, h: Number(cSub.h) || 0.5, color: cSub.color ? cSub.color.replace('#','') : secondaryColor, fontSize: Number(cSub.fontSize) || 14, fontFace: cSub.fontFace || fontName, align: cSub.align || 'left', valign: 'middle' }
                        }
                    });
                }

                /* Footer "Total: N registros" — aparece en TODAS las páginas autoPage
                   porque va inyectado en el master del slide, no en una slide concreta.
                   Solo cuenta filas de bloques tabla/chart-solo (no pivots).
                   Backward compat: si showRecordCountFooter está OFF, no se añade nada. */
                if (this.showRecordCountFooter && slideHasCountableBlocks) {
                    const positions = {
                        'top-right':     { x: 10.5, y: 0.2, w: 2.6, h: 0.28, align: 'right'  },
                        'bottom-right':  { x: 10.5, y: 7.05, w: 2.6, h: 0.28, align: 'right'  },
                        'bottom-left':   { x: 0.3,  y: 7.05, w: 4.0, h: 0.28, align: 'left'   },
                        'bottom-center': { x: 4.7,  y: 7.05, w: 4.0, h: 0.28, align: 'center' }
                    };
                    const pos = positions[this.recordCountPosition] || positions['bottom-right'];
                    masterObjects.push({
                        text: {
                            text: `Total: ${slideTotalRecords.toLocaleString('es-CL')} registros`,
                            options: {
                                x: pos.x, y: pos.y, w: pos.w, h: pos.h,
                                fontFace: fontName,
                                fontSize: 9,
                                color: '64748B',
                                italic: true,
                                align: pos.align,
                                valign: 'middle',
                                margin: 0
                            }
                        }
                    });
                }

                let masterDef = { title: slideMasterName, objects: masterObjects };
                if (bgContenido) masterDef.background = { data: bgContenido.data };
                else masterDef.background = { color: 'FFFFFF' };

                pptx.defineSlideMaster(masterDef);

                /* CORRECCIÓN AUTOPAGE: cada bloque (tableDef) va en su propia slide PPTX con el mismo master.
                   Antes todos los bloques compartían una slide y, cuando una tabla con autoPage generaba
                   slides de continuación, los bloques siguientes se pintaban encima del contenido paginado.
                   Ahora cada bloque tiene su propio "espacio" autoPage sin solaparse con vecinos. */
                const blocksToRender = slideDef.tables || [];
                /* Las notas de orador van en el primer slide PPTX del slideDef.
                   PowerPoint las muestra junto a esa diapositiva; si una tabla con autoPage
                   genera continuaciones, las notas siguen perteneciendo al slide original. */
                const speakerNotesText = (slideDef.speakerNotes || '').trim();
                let isFirstBlockSlide = true;
                if (!blocksToRender.length) {
                    const emptySlide = pptx.addSlide({ masterName: slideMasterName });
                    if (speakerNotesText) emptySlide.addNotes(speakerNotesText);
                    applySlideLogo(emptySlide, slideDef);
                    continue;
                }

                for (const tableDef of blocksToRender) {
                    const sheetData = this.parsedExcelData?.[tableDef.sheetName]; 
                    if (!sheetData) continue;

                    /* Borde efectivo para todas las addTable de este bloque:
                       respeta el borde configurado en reporteKaufmann (pestaña
                       Formato > Bordes) si se detectó durante el parseo del Excel.
                       Si no, cae al gris claro histórico para no romper PPTs
                       de hojas que no traen formato de bordes (ej. Excel externo). */
                    const effectiveTableBorder = sheetData.tableBorder
                        || { type: 'solid', color: 'DFE5EF', pt: 1 };
                    
                    let filteredRows = sheetData.rows;
                    (tableDef.filters || []).forEach(f => { 
                        if (isFilterUsableAdvanced(f)) {
                            filteredRows = filteredRows.filter(r => applyBlockFilter(r[f.column], f));
                        }
                    });

                    /* Nueva slide PPTX por bloque. Toma el master con título/subtítulo del slideDef. */
                    const slide = pptx.addSlide({ masterName: slideMasterName });
                    if (isFirstBlockSlide && speakerNotesText) {
                        slide.addNotes(speakerNotesText);
                    }
                    isFirstBlockSlide = false;
                    applySlideLogo(slide, slideDef);
                    let currentY = tableStartY;

                    const td = this.normalizeTableChartConfig(tableDef);
                    if (this.isPivotBlock(td)) {
                        this.ensurePivotColumnDefaults(td, sheetData);
                        const {
                            agg,
                            g,
                            vCol,
                            labels,
                            values
                        } = this.finalizePivotAggregation(filteredRows, td);
                        const pivotHoriz = td.pivotOrientation === 'horizontal';
                        const pivotTableWidth = pivotHoriz ? 12.2 : 8.2;
                        let startXP = 0.4;
                        if (td.tableAlign === 'center') {
                            startXP = (13.33 - pivotTableWidth) / 2;
                        } else if (td.tableAlign === 'right') {
                            startXP = 13.33 - pivotTableWidth - 0.4;
                        }
                        /* Título del bloque (subtabla) sobre la tabla, si existe. */
                        currentY = renderBlockTitleIfAny(slide, td, currentY, startXP, pivotTableWidth);
                        const styleG = sheetData.columnStyles[g] || {};
                        const styleV = sheetData.columnStyles[vCol] || {};
                        const hCat = g || '—';
                        const hVal = this.pivotMetricHeaderLabel(td);
                        const headerFontPz = 10;
                        const dataFontPz = 9;
                        const tableDataP = [];

                        if (pivotHoriz) {
                            const hasTot = !!(td.pivotShowTotal && labels.length);
                            const nCols = 1 + labels.length + (hasTot ? 1 : 0);
                            const colWEach = Number((pivotTableWidth / nCols).toFixed(4));
                            const colW = Array(nCols).fill(colWEach);
                            const headRow = [
                                this.buildPptxTableStyledCell(hCat, {
                                    fontFace: fontName, fontSize: headerFontPz, bold: true, align: 'center',
                                    fill: { color: styleG.headFill || primaryColor },
                                    color: styleG.headColor || 'FFFFFF'
                                }),
                                ...labels.map((lb) =>
                                    this.buildPptxTableStyledCell(String(lb), {
                                        fontFace: fontName, fontSize: headerFontPz, bold: true, align: 'center',
                                        fill: { color: styleG.headFill || primaryColor },
                                        color: styleG.headColor || 'FFFFFF'
                                    })
                                )
                            ];
                            if (hasTot) {
                                headRow.push(
                                    this.buildPptxTableStyledCell('Total', {
                                        fontFace: fontName, fontSize: headerFontPz, bold: true, align: 'center',
                                        fill: { color: 'CBD5E1' }, color: '000000'
                                    })
                                );
                            }
                            tableDataP.push(headRow);

                            let totAgg;
                            if (hasTot) {
                                if (agg === 'avg') {
                                    const s = values.reduce((a, b) => a + (Number(b) || 0), 0);
                                    totAgg = s / labels.length;
                                } else {
                                    totAgg = values.reduce((a, b) => a + (Number(b) || 0), 0);
                                }
                            }

                            const dataRow = [
                                this.buildPptxTableStyledCell(hVal, {
                                    fontFace: fontName, fontSize: dataFontPz, bold: true, align: 'center',
                                    fill: { color: styleV.headFill || secondaryColor },
                                    color: styleV.headColor || 'FFFFFF'
                                }),
                                ...labels.map((_lb, idx) => {
                                    const bgFill = styleV.dataFill || ((idx % 2 === 0) ? 'F9F9F9' : 'FFFFFF');
                                    const disp = String(this.formatPivotMetricDisplay(td, values[idx], idx));
                                    return this.buildPptxTableStyledCell(disp, {
                                        fontFace: fontName, fontSize: dataFontPz, align: 'center',
                                        fill: { color: bgFill },
                                        color: styleV.dataColor || '000000'
                                    });
                                })
                            ];
                            if (hasTot) {
                                const dispTot = String(this.formatPivotMetricDisplay(td, totAgg, -1));
                                dataRow.push(
                                    this.buildPptxTableStyledCell(dispTot, {
                                        fontFace: fontName, fontSize: dataFontPz, bold: true, align: 'center',
                                        fill: { color: 'E2E8F0' }, color: '000000'
                                    })
                                );
                            }
                            tableDataP.push(dataRow);

                            slide.addTable(tableDataP, {
                                x: startXP,
                                y: currentY,
                                w: pivotTableWidth,
                                colW,
                                border: effectiveTableBorder,
                                autoPage: true,
                                autoPageSlideStartY: tableStartY,
                                autoPageRepeatHeader: true,
                                autoPageHeaderRows: 1,
                                autoPageLineWeight: PPT_TABLE_AUTOPAGE_LINE_WEIGHT,
                                autoPageCharWeight: PPT_TABLE_AUTOPAGE_CHAR_WEIGHT,
                                slideMargin: PPT_TABLE_SLIDE_MARGIN_IN,
                                valign: 'middle',
                                margin: 0.03
                            });
                        } else {
                            tableDataP.push([
                                this.buildPptxTableStyledCell(hCat, {
                                    fontFace: fontName, fontSize: headerFontPz, bold: true, align: 'center',
                                    fill: { color: styleG.headFill || primaryColor },
                                    color: styleG.headColor || 'FFFFFF'
                                }),
                                this.buildPptxTableStyledCell(hVal, {
                                    fontFace: fontName, fontSize: headerFontPz, bold: true, align: 'center',
                                    fill: { color: styleV.headFill || primaryColor },
                                    color: styleV.headColor || 'FFFFFF'
                                })
                            ]);
                            labels.forEach((lb, idx) => {
                                const bgFill = styleG.dataFill || ((idx % 2 === 0) ? 'F9F9F9' : 'FFFFFF');
                                const bgFill2 = styleV.dataFill || ((idx % 2 === 0) ? 'F9F9F9' : 'FFFFFF');
                                const disp = String(this.formatPivotMetricDisplay(td, values[idx], idx));
                                tableDataP.push([
                                    this.buildPptxTableStyledCell(String(lb), {
                                        fontFace: fontName, fontSize: dataFontPz, align: 'center',
                                        fill: { color: bgFill }, color: styleG.dataColor || '000000'
                                    }),
                                    this.buildPptxTableStyledCell(disp, {
                                        fontFace: fontName, fontSize: dataFontPz, align: 'center',
                                        fill: { color: bgFill2 }, color: styleV.dataColor || '000000'
                                    })
                                ]);
                            });
                            if (td.pivotShowTotal && labels.length) {
                                let tot;
                                if (agg === 'avg') {
                                    const s = values.reduce((a, b) => a + (Number(b) || 0), 0);
                                    tot = s / values.length;
                                } else {
                                    tot = values.reduce((a, b) => a + (Number(b) || 0), 0);
                                }
                                const dispTot = String(this.formatPivotMetricDisplay(td, tot, -1));
                                tableDataP.push([
                                    this.buildPptxTableStyledCell('Total', {
                                        fontFace: fontName, fontSize: dataFontPz, bold: true, align: 'center',
                                        fill: { color: 'E2E8F0' }, color: '000000'
                                    }),
                                    this.buildPptxTableStyledCell(dispTot, {
                                        fontFace: fontName, fontSize: dataFontPz, bold: true, align: 'center',
                                        fill: { color: 'E2E8F0' }, color: '000000'
                                    })
                                ]);
                            }

                            slide.addTable(tableDataP, {
                                x: startXP,
                                y: currentY,
                                w: pivotTableWidth,
                                colW: [pivotTableWidth * 0.52, pivotTableWidth * 0.48],
                                border: effectiveTableBorder,
                                autoPage: true,
                                autoPageSlideStartY: tableStartY,
                                autoPageRepeatHeader: true,
                                autoPageHeaderRows: 1,
                                autoPageLineWeight: PPT_TABLE_AUTOPAGE_LINE_WEIGHT,
                                autoPageCharWeight: PPT_TABLE_AUTOPAGE_CHAR_WEIGHT,
                                slideMargin: PPT_TABLE_SLIDE_MARGIN_IN,
                                valign: 'middle',
                                margin: 0.03
                            });
                        }
                        continue;
                    }

                    this.ensureChartColumnDefaults(td);
                    const chartCore = td.hasChart ? this.computeChartAggregation(td, filteredRows) : null;
                    const isValidChart = !!chartCore;
                    const chartSolo = isValidChart && (td.chartPosition || '') === 'solo';

                    if (chartSolo && chartCore) {
                        const pptxChartEnum = this.resolvePptxChartType(pptx, td.chartType);
                        if (!pptxChartEnum) {
                            console.error('PptxGenJS: tipo de gráfico no disponible en esta versión');
                        } else {
                            const chartDataObj = [{ name: chartCore.valCol, labels: chartCore.labels, values: chartCore.values }];
                            const dim = this.getChartSizePresetDims(td.chartSizePreset);
                            const cw = Math.min(11.8, dim.w + 3.2);
                            const ch = Math.max(dim.h, 3.4);
                            const chartX = (13.33 - cw) / 2;
                            const chartTitle = (td.chartTitle && td.chartTitle.trim()) ? td.chartTitle.trim() : `Resumen: ${chartCore.catCol}`;
                            /* Título del bloque (chart-solo) sobre el gráfico, si existe. */
                            currentY = renderBlockTitleIfAny(slide, td, currentY, chartX, cw);
                            const optsSolo = {
                                ...this.buildChartExportOptions(td, primaryColor, secondaryColor, fontName, chartTitle),
                                x: chartX,
                                y: currentY,
                                w: cw,
                                h: ch
                            };
                            slide.addChart(pptxChartEnum, chartDataObj, optsSolo);
                        }
                        continue;
                    }

                    if (!tableDef.selectedColumns?.length) continue;

                    const chartRight = isValidChart && (td.chartPosition || 'right') === 'right';
                    let tableWidth = isValidChart && chartRight ? 7.5 : 12.5;

                    let totalExcelWidth = 0;
                    td.selectedColumns.forEach(h => { 
                        let w = Number(sheetData.columnStyles[h.trim()]?.width);
                        if (isNaN(w) || w <= 0) w = 15; 
                        totalExcelWidth += w; 
                    });
                    
                    let pptColWidths = td.selectedColumns.map(h => {
                        let w = Number(sheetData.columnStyles[h.trim()]?.width);
                        if (isNaN(w) || w <= 0) w = 15;
                        return Number(((w / totalExcelWidth) * tableWidth).toFixed(2));
                    });

                    let startX = 0.4;
                    if (td.tableAlign === 'center') {
                        startX = (13.33 - tableWidth) / 2;
                    } else if (td.tableAlign === 'right') {
                        startX = 13.33 - tableWidth - 0.4;
                    }

                    /* Título del bloque (tabla): se renderiza más abajo dentro del loop
                       de chunks para soportar el sufijo "(parte X/N)" cuando hay split. */

                    let colCount = td.selectedColumns.length;
                    let dynamicHeaderFontSize = colCount > 8 ? 8 : 10;
                    let dynamicDataFontSize = colCount > 8 ? 8 : 9;
                    let tableLineWeight = PPT_TABLE_AUTOPAGE_LINE_WEIGHT;
                    let tableCharWeight = PPT_TABLE_AUTOPAGE_CHAR_WEIGHT;
                    let tableCellMargin = 0.03;
                    /* Override de densidad por bloque. Si el usuario eligió un preset
                       distinto de 'auto', sobreescribimos los valores dinámicos. Cuando
                       es 'auto' dejamos que los ajustes posteriores (por longitud de
                       texto, columna "Reporte avance", etc.) sigan operando. */
                    const blockDensity = td.tableDensity || 'auto';
                    if (blockDensity === 'compact') {
                        dynamicHeaderFontSize = 8;
                        dynamicDataFontSize = 7;
                        tableCellMargin = 0.02;
                    } else if (blockDensity === 'normal') {
                        dynamicHeaderFontSize = 10;
                        dynamicDataFontSize = 9;
                        tableCellMargin = 0.03;
                    } else if (blockDensity === 'spacious') {
                        dynamicHeaderFontSize = 12;
                        dynamicDataFontSize = 11;
                        tableCellMargin = 0.06;
                    }
                    // Si hay textos muy largos, bajar un punto para evitar "última página huérfana".
                    const maxLenInRows = filteredRows.slice(0, 200).reduce((acc, rowObj) => {
                        let localMax = 0;
                        td.selectedColumns.forEach((h) => {
                            const safeH = h.trim();
                            let val = rowObj[safeH];
                            if (val === undefined) val = rowObj[h];
                            const ln = val === null || val === undefined ? 0 : String(val).length;
                            if (ln > localMax) localMax = ln;
                        });
                        return Math.max(acc, localMax);
                    }, 0);
                    /* Ajustes automáticos por longitud de texto: solo si el usuario NO
                       eligió un preset de densidad explícito. En ese caso respetamos su
                       elección y no la pisamos. */
                    if (blockDensity === 'auto') {
                        if (maxLenInRows > 420) {
                            dynamicDataFontSize = Math.max(8, dynamicDataFontSize - 0.5);
                            tableLineWeight = 0.56;
                            tableCharWeight = 0.13;
                            tableCellMargin = 0.03;
                        }
                        if (maxLenInRows > 700) {
                            dynamicDataFontSize = Math.max(7.5, dynamicDataFontSize - 1);
                            tableLineWeight = 0.62;
                            tableCharWeight = 0.16;
                            tableCellMargin = 0.035;
                        }
                    }

                    // Modo texto extremo: prioriza "Reporte Avance" para evitar cola huérfana en la última slide.
                    // También respeta el preset de densidad explícito del usuario.
                    const repIdx = td.selectedColumns.findIndex((h) => String(h || '').toLowerCase().includes('reporte avance'));
                    if (repIdx >= 0 && blockDensity === 'auto') {
                        const repColName = td.selectedColumns[repIdx];
                        const repMaxLen = filteredRows.slice(0, 250).reduce((mx, rowObj) => {
                            let val = rowObj[String(repColName || '').trim()];
                            if (val === undefined) val = rowObj[repColName];
                            return Math.max(mx, val === null || val === undefined ? 0 : String(val).length);
                        }, 0);
                        if (repMaxLen > 300) {
                            // Legibilidad primero: menos filas por slide y saltos más tempranos.
                            dynamicDataFontSize = Math.max(dynamicDataFontSize, 7.5);
                            dynamicHeaderFontSize = Math.max(dynamicHeaderFontSize, 8);
                            tableLineWeight = Math.max(tableLineWeight, 0.66);
                            tableCharWeight = Math.max(tableCharWeight, 0.18);
                            tableCellMargin = Math.max(tableCellMargin, 0.04);

                            const minRepWidth = Number((tableWidth * 0.24).toFixed(2));
                            if ((pptColWidths[repIdx] || 0) < minRepWidth) {
                                const delta = Number((minRepWidth - (pptColWidths[repIdx] || 0)).toFixed(2));
                                pptColWidths[repIdx] = minRepWidth;
                                const others = td.selectedColumns.map((_x, i) => i).filter((i) => i !== repIdx);
                                const totalOthers = others.reduce((a, i) => a + (pptColWidths[i] || 0), 0) || 1;
                                others.forEach((i) => {
                                    const cut = Number((delta * ((pptColWidths[i] || 0) / totalOthers)).toFixed(2));
                                    pptColWidths[i] = Math.max(0.34, Number(((pptColWidths[i] || 0) - cut).toFixed(2)));
                                });
                                const sumW = pptColWidths.reduce((a, b) => a + b, 0) || 1;
                                const factor = tableWidth / sumW;
                                pptColWidths = pptColWidths.map((w) => Number((w * factor).toFixed(2)));
                            }
                        }
                    }

                    /* === Decisión de split horizontal ===
                       Si td.respectOriginalWidths está activo Y la suma de los anchos del
                       Excel original (convertidos a pulgadas) excede el ancho disponible
                       del slide, partimos las columnas en chunks y generamos una slide PPT
                       por chunk. Si no, comportamiento legacy: 1 chunk con todas las columnas
                       y los `pptColWidths` proporcionales calculados arriba. */
                    const EXCEL_W_TO_IN = 0.083; // Aproximación Calibri 11pt @ 96dpi
                    const realInchWidths = td.selectedColumns.map((h) => {
                        let w = Number(sheetData.columnStyles[h.trim()]?.width);
                        if (isNaN(w) || w <= 0) w = 15;
                        return Math.max(0.6, Math.min(7.5, Number((w * EXCEL_W_TO_IN).toFixed(2))));
                    });
                    const totalRealWidthIn = realInchWidths.reduce((a, b) => a + b, 0);
                    const useOriginalWidths = td.respectOriginalWidths === true;
                    const needHorizontalSplit = useOriginalWidths && totalRealWidthIn > (tableWidth + 0.1);

                    /* Si necesita split y había chart side-by-side, lo movemos a "below"
                       para no romper la maquetación. */
                    let effectiveChartRight = chartRight;
                    let effectiveTableWidth = tableWidth;
                    if (needHorizontalSplit && chartRight) {
                        effectiveChartRight = false;
                        effectiveTableWidth = 12.5;
                    }

                    const columnChunks = needHorizontalSplit
                        ? this.splitColumnsIntoChunks(realInchWidths, effectiveTableWidth, true)
                        : [td.selectedColumns.map((_, i) => i)];

                    const baseTitleY = currentY;
                    const totalChunks = columnChunks.length;

                    /* Paginación SIEMPRE manual por filas. El toggle `showPageNumbers`
                       solo controla si se renderiza el texto "Pag X/N", NO si se hace
                       la paginación. Antes hacíamos `autoPage: !useManualPagination`,
                       pero eso dejaba al usuario sin red de seguridad cuando el toggle
                       estaba OFF y rompía silenciosamente las tablas grandes (todas
                       las filas apiladas en una sola slide).
                       Ahora siempre cortamos las filas en chunks que quepan; solo la
                       numeración visible depende del toggle. */
                    const showPageNumberFooter = this.showPageNumbers === true;
                    const baseBlockTitleRaw = (td.blockTitle || '').trim();
                    /* Reservamos espacio para el blockTitle si lo hay o si va a haber
                       sufijo "(parte X/N)" por split horizontal de columnas. */
                    const reservesBlockTitleArea = !!(baseBlockTitleRaw || totalChunks > 1);
                    const blockTitleSpace = reservesBlockTitleArea ? (BLOCK_TITLE_HEIGHT + BLOCK_TITLE_GAP) : 0;
                    const PAGE_FOOTER_SPACE = 0.35;
                    const SLIDE_USABLE_HEIGHT = 5.625;
                    /* PPT_TABLE_SLIDE_MARGIN_IN es un array [top, right, bottom, left] en
                       pulgadas. Para el cálculo de altura disponible solo nos interesa el
                       bottom (índice 2), que es el margen real que pptxgenjs respeta al
                       final de la tabla. */
                    const slideBottomMarginIn = Array.isArray(PPT_TABLE_SLIDE_MARGIN_IN)
                        ? (Number(PPT_TABLE_SLIDE_MARGIN_IN[2]) || 0.45)
                        : (Number(PPT_TABLE_SLIDE_MARGIN_IN) || 0.45);
                    /* Estimación de altura por fila (pulgadas). Conservadora: en pptxgenjs
                       con fontSize 9 y márgenes pequeños cada fila ocupa ~0.28" en datos
                       cortos, pero si hay wrap (textos largos con varias líneas) puede
                       crecer a 0.5"+. Sumamos un padding fijo y ajustamos al alza si
                       detectamos textos largos en las filas. */
                    let rowHeightEst = (dynamicDataFontSize / 72) * 1.5 + 0.12;
                    const headerHeightEst = (dynamicHeaderFontSize / 72) * 1.6 + 0.12;
                    /* Si el texto promedio por celda es muy largo, asumimos wrap a 2+
                       líneas y aumentamos la altura estimada por fila. Esto evita el
                       caso del usuario donde 223 filas (algunas con descripciones largas)
                       se aplastaban en una sola slide. */
                    if (maxLenInRows > 80) {
                        rowHeightEst += 0.08;
                    }
                    if (maxLenInRows > 200) {
                        rowHeightEst += 0.08;
                    }
                    const availableTableHeight = Math.max(
                        0.6,
                        SLIDE_USABLE_HEIGHT - tableStartY - slideBottomMarginIn - blockTitleSpace - (showPageNumberFooter ? PAGE_FOOTER_SPACE : 0) - headerHeightEst
                    );
                    let rowsPerSlide = Math.max(1, Math.floor(availableTableHeight / rowHeightEst));
                    /* Override manual por bloque. Si el usuario configuró un máximo
                       explícito, lo respetamos pero capamos al máximo automático para
                       no provocar overflow visible cuando el texto es muy largo. Si el
                       override es mayor que la estimación automática, gana el override
                       (asumimos que el usuario sabe lo que hace y prefiere más filas). */
                    const overrideRaw = Number(td.maxRowsPerSlideOverride);
                    if (Number.isFinite(overrideRaw) && overrideRaw > 0) {
                        rowsPerSlide = Math.max(1, Math.floor(overrideRaw));
                    }

                    /* Chunks de filas. La paginación se ejecuta siempre que las filas no
                       caben en una slide; el toggle showPageNumberFooter solo afecta a la
                       numeración visible. */
                    let rowChunks;
                    if (filteredRows.length === 0) {
                        rowChunks = [[]];
                    } else if (filteredRows.length > rowsPerSlide) {
                        rowChunks = [];
                        for (let r = 0; r < filteredRows.length; r += rowsPerSlide) {
                            rowChunks.push(filteredRows.slice(r, r + rowsPerSlide));
                        }
                    } else {
                        rowChunks = [filteredRows];
                    }
                    const totalPages = totalChunks * rowChunks.length;

                    columnChunks.forEach((chunkIndices, chunkIdx) => {
                        const isMultiChunk = totalChunks > 1;

                        /* Columnas y anchos del chunk. Si usamos anchos originales,
                           los aplicamos en pulgadas reales (manteniendo el aspecto del Excel).
                           Si no, todos los chunks comparten los pptColWidths proporcionales
                           (caso normal con 1 solo chunk). */
                        const chunkColumns = chunkIndices.map((i) => td.selectedColumns[i]);
                        let chunkColW;
                        let chunkTableWidthEff;
                        if (useOriginalWidths) {
                            chunkColW = chunkIndices.map((i) => realInchWidths[i]);
                            chunkTableWidthEff = chunkColW.reduce((a, b) => a + b, 0);
                            if (chunkTableWidthEff > effectiveTableWidth) {
                                const factor = effectiveTableWidth / chunkTableWidthEff;
                                chunkColW = chunkColW.map((w) => Number((w * factor).toFixed(2)));
                                chunkTableWidthEff = effectiveTableWidth;
                            }
                            chunkTableWidthEff = Number(chunkTableWidthEff.toFixed(2));
                        } else {
                            chunkColW = pptColWidths;
                            chunkTableWidthEff = effectiveTableWidth;
                        }

                        let chunkStartX = 0.4;
                        if (td.tableAlign === 'center') {
                            chunkStartX = (13.33 - chunkTableWidthEff) / 2;
                        } else if (td.tableAlign === 'right') {
                            chunkStartX = 13.33 - chunkTableWidthEff - 0.4;
                        }

                        rowChunks.forEach((rowChunk, rowChunkIdx) => {
                            const pageIdx = chunkIdx * rowChunks.length + rowChunkIdx;
                            const isFirstPage = pageIdx === 0;

                            /* Slide destino: la primera página va en `slide` (ya creado).
                               Las siguientes generan su propia slide con el mismo master. */
                            let targetSlide;
                            if (isFirstPage) {
                                targetSlide = slide;
                            } else {
                                targetSlide = pptx.addSlide({ masterName: slideMasterName });
                                applySlideLogo(targetSlide, slideDef);
                            }

                            /* Título de la página: blockTitle base + sufijo "(parte X/N)"
                               si hay split horizontal. Si no hay blockTitle ni split, se
                               omite y la tabla empieza más arriba. */
                            let pageY = isFirstPage ? baseTitleY : tableStartY;
                            const partLabel = isMultiChunk ? `(parte ${chunkIdx + 1}/${totalChunks})` : '';
                            const fullTitle = baseBlockTitleRaw && partLabel
                                ? `${baseBlockTitleRaw} ${partLabel}`
                                : (baseBlockTitleRaw || partLabel);
                            if (fullTitle) {
                                targetSlide.addText(fullTitle, {
                                    x: chunkStartX, y: pageY, w: chunkTableWidthEff, h: BLOCK_TITLE_HEIGHT,
                                    fontFace: fontName, fontSize: 12, bold: true, color: primaryColor,
                                    align: 'left', valign: 'middle', margin: 0
                                });
                                pageY = Number((pageY + BLOCK_TITLE_HEIGHT + BLOCK_TITLE_GAP).toFixed(2));
                            }

                            /* Header + filas SOLO de este chunk de columnas y filas. */
                            const chunkTableData = [];
                            chunkTableData.push(chunkColumns.map((h) => {
                                const safeH = h.trim();
                                const style = sheetData.columnStyles[safeH] || {};
                                return this.buildPptxTableStyledCell(h, {
                                    fontFace: fontName, fontSize: dynamicHeaderFontSize, bold: true, align: 'center',
                                    fill: { color: style.headFill || primaryColor },
                                    color: style.headColor || 'FFFFFF'
                                });
                            }));

                            rowChunk.forEach((r, idx) => {
                                chunkTableData.push(chunkColumns.map((h) => {
                                    const safeH = h.trim();
                                    const style = sheetData.columnStyles[safeH] || {};
                                    const bgFill = style.dataFill || ((idx % 2 === 0) ? 'F9F9F9' : 'FFFFFF');
                                    let val = r[safeH];
                                    if (val === undefined) val = r[h];
                                    const cellText = (val !== null && val !== undefined) ? String(val) : '';
                                    const isRepCell = String(h || '').toLowerCase().includes('reporte avance');
                                    return this.buildPptxTableStyledCell(cellText, {
                                        fontFace: fontName, fontSize: dynamicDataFontSize, align: isRepCell ? 'left' : 'center',
                                        fill: { color: bgFill },
                                        color: style.dataColor || '000000'
                                    });
                                }));
                            });

                            targetSlide.addTable(chunkTableData, {
                                x: chunkStartX,
                                y: pageY,
                                w: chunkTableWidthEff,
                                colW: chunkColW,
                                border: effectiveTableBorder,
                                /* autoPage desactivado: ya cortamos las filas manualmente
                                   y necesitamos que pptxgenjs NO inserte slides intermedias
                                   sin numerar (eso rompería la secuencia "Pag X/N").
                                   Si la estimación de rowsPerSlide se quedara corta para
                                   un caso edge (textos extremadamente largos), aumentar el
                                   padding en rowHeightEst arriba. */
                                autoPage: false,
                                slideMargin: PPT_TABLE_SLIDE_MARGIN_IN,
                                valign: 'middle',
                                margin: tableCellMargin
                            });

                            /* "Pag X / N" en la esquina inferior derecha cuando hay más de
                               una página y el usuario activó el toggle. Estilo similar al
                               ejemplo del usuario: texto en color primario, semibold,
                               alineado a la derecha. */
                            if (showPageNumberFooter && totalPages > 1) {
                                targetSlide.addText(`Pag ${pageIdx + 1} / ${totalPages}`, {
                                    x: 10.5, y: 7.0, w: 2.6, h: 0.3,
                                    fontFace: fontName, fontSize: 12, bold: true,
                                    color: primaryColor,
                                    align: 'right', valign: 'middle', margin: 0
                                });
                            }

                            /* Chart side-by-side: solo en la primera página de la primera
                               columna del chunk y si NO hubo split horizontal. En split
                               horizontal el chart va "below" en una slide aparte. */
                            if (isFirstPage && effectiveChartRight && isValidChart && chartCore) {
                                const pptxChartEnum = this.resolvePptxChartType(pptx, td.chartType);
                                if (pptxChartEnum) {
                                    const chartDataObj = [{ name: chartCore.valCol, labels: chartCore.labels, values: chartCore.values }];
                                    const { w: cw, h: ch } = this.getChartSizePresetDims(td.chartSizePreset);
                                    const chartTitle = (td.chartTitle && td.chartTitle.trim()) ? td.chartTitle.trim() : `Resumen: ${chartCore.catCol}`;
                                    const chartOpts = {
                                        ...this.buildChartExportOptions(td, primaryColor, secondaryColor, fontName, chartTitle),
                                        w: cw,
                                        h: ch
                                    };
                                    const chartX = chunkStartX + chunkTableWidthEff + 0.5;
                                    targetSlide.addChart(pptxChartEnum, chartDataObj, { ...chartOpts, x: chartX, y: pageY });
                                }
                            }
                        });
                    });

                    /* Chart "below": va en su propia slide DESPUÉS del último chunk.
                       También se activa cuando había chart side-by-side pero forzamos split. */
                    if (isValidChart && chartCore && !effectiveChartRight) {
                        const pptxChartEnum = this.resolvePptxChartType(pptx, td.chartType);
                        if (pptxChartEnum) {
                            const chartDataObj = [{ name: chartCore.valCol, labels: chartCore.labels, values: chartCore.values }];
                            const { w: cw, h: ch } = this.getChartSizePresetDims(td.chartSizePreset);
                            const chartTitle = (td.chartTitle && td.chartTitle.trim()) ? td.chartTitle.trim() : `Resumen: ${chartCore.catCol}`;
                            const chartOpts = {
                                ...this.buildChartExportOptions(td, primaryColor, secondaryColor, fontName, chartTitle),
                                w: cw,
                                h: ch
                            };
                            const chartSlide = pptx.addSlide({ masterName: slideMasterName });
                            const chartY = tableStartY;
                            const chartX = (13.33 - cw) / 2;
                            chartSlide.addChart(pptxChartEnum, chartDataObj, { ...chartOpts, x: chartX, y: chartY });
                            applySlideLogo(chartSlide, slideDef);
                        }
                    }
                }
            }

            await this.updateProgress(90, 'Empaquetando PPT final...');

            if (this.includeClosing) {
                const closing = pptx.addSlide(); const bg = getImageConfig(layout.slides.cierre.bgDocId);
                if (bg) closing.addImage(bg); else closing.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: '100%', fill: { color: 'F3F4F6' } });
                const endTitle = layout.slides.cierre.title;
                closing.addText(this.closingText || '', { x: Number(endTitle.x), y: Number(endTitle.y), w: Number(endTitle.w) || 12.0, h: Number(endTitle.h) || 2.0, color: endTitle.color ? endTitle.color.replace('#','') : primaryColor, fontSize: Number(endTitle.fontSize) || 32, fontFace: endTitle.fontFace || fontName, bold: endTitle.bold !== false, align: endTitle.align || 'center', valign: 'middle', wrap: true, shrinkText: true });
            }

            const blob = await pptx.write('blob'); const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = this.buildPptxFileName(); a.style.display = 'none'; document.body.appendChild(a); a.click();
            
            await this.updateProgress(100, '¡Descarga Completa!');

            setTimeout(() => { 
                URL.revokeObjectURL(url); 
                document.body.removeChild(a); 
                this.isExporting = false;
                this.showToast('Éxito', 'Presentación generada exitosamente.', 'success');
            }, 1000);

        } catch (e) { 
            console.error(e); 
            this.showToast('Error', 'Fallo al generar el PPT.', 'error'); 
            this.isExporting = false;
        }
    }
    /** Construye el nombre del .pptx: título portada + variante del reporte (si llega) + variante PPT + fecha. */
    buildPptxFileName() {
        const sanitize = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 60);
        const titlePart = sanitize(this.coverTitle) || 'Reporte';
        const reportVariantPart = sanitize(this.reportVariantName);
        const pptVariantLabel = (this.pptPresentations || []).find(p => p.id === this.activePresentationId)?.label;
        const pptVariantPart = sanitize(pptVariantLabel);
        const datePart = new Date().toISOString().slice(0, 10);
        const parts = [titlePart, reportVariantPart, pptVariantPart, datePart].filter(Boolean);
        return `${parts.join('_')}.pptx`;
    }

    showToast(t, m, v, mode) { this.dispatchEvent(new ShowToastEvent({ title: t, message: m, variant: v, mode: mode || 'dismissable' })); }
}