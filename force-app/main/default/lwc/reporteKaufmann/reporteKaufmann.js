import { LightningElement, api, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import { loadScript } from 'lightning/platformResourceLoader';
import EXCEL_JS from '@salesforce/resourceUrl/exceljs';
import JSPDF from '@salesforce/resourceUrl/jspdf';
import JSPDF_AUTOTABLE from '@salesforce/resourceUrl/jspdfAutotable';
/* F5: Chart.js como Static Resource.
   El recurso debe llamarse "chartjs" y exponer el build UMD en la raíz como `chart.umd.js`
   (o renombrar la línea de loadScript). Si el recurso no existe, los gráficos se
   degradan a un mensaje informativo y el resto del taller sigue funcionando. */
import CHARTJS from '@salesforce/resourceUrl/chartjs';

import getAvailableReports from '@salesforce/apex/ReporteKaufmannController.getAvailableReports';
import getReportData from '@salesforce/apex/ReporteKaufmannController.getReportData';
import saveTemplate from '@salesforce/apex/ReporteKaufmannController.saveTemplate';
import getTemplate from '@salesforce/apex/ReporteKaufmannController.getTemplate';
import saveExcelToSalesforce from '@salesforce/apex/ReporteKaufmannController.saveExcelToSalesforce';
/* V: variantes de plantilla (múltiples versiones por reporte). */
import listVariants from '@salesforce/apex/ReporteKaufmannController.listVariants';
import getVariant from '@salesforce/apex/ReporteKaufmannController.getVariant';
import saveVariant from '@salesforce/apex/ReporteKaufmannController.saveVariant';
import deleteVariantApex from '@salesforce/apex/ReporteKaufmannController.deleteVariant';
import duplicateVariantApex from '@salesforce/apex/ReporteKaufmannController.duplicateVariant';
import { parseImageDataUrl, getJsPdfImageFormat, getEffectiveExcelTableStartRow } from './reporteKaufmannExportUtils';
import { computeVirtualCellValue, getRowsForSheet, calculatePivotData, FILTER_OPERATORS, FILTER_OPERATOR_MAP, isFilterUsable, resolveFilterOperator } from './reporteKaufmannPivotUtils';

export default class ReporteKaufmann extends LightningElement {
    static UI_MODE_STORAGE_KEY = 'pandora_ui_mode';
    /** Solo tras activar explícitamente «experiencia libro» en la sesión se restaura modo avanzado guardado. */
    static EXPERIENCE_SESSION_KEY = 'pandora_kaufmann_experience_ok';
    static UI_DENSITY_STORAGE_KEY = 'pandora_ui_density';
    static FAVORITES_STORAGE_KEY = 'pandora_favorite_reports';
    static DARK_MODE_STORAGE_KEY = 'pandora_dark_mode';
    static LOGO_IDB_NAME = 'pandora_kaufmann_logos';
    static LOGO_IDB_STORE = 'logos';
    static LOGO_MAX_FILE_BYTES = Math.floor(1.8 * 1024 * 1024);
    static LOGO_MAX_PX = 1280;
    @api recordId;

    @track reportOptions = []; @track selectedReportId = ''; @track reportDataJson = '';
    @track baseColumns = []; @track summaryOptions = []; @track numericSummaryOptions = [];
    @track dynamicFilterOptions = [{label: 'Ninguno / Todos', value: ''}];
    @track workbookConfig = { version: '2.0', theme: { font: 'Calibri', primaryColor: '#0070C0' }, sheets: [] };

    /* V: estado de variantes (múltiples versiones por reporte).
       - availableVariants: array de { varianteId, nombre, esDefault, esPublica, canEdit, lastModifiedDate, ownerUserName }.
       - currentVariantId: id de la variante actualmente cargada.
       - showVariantManagerModal: true cuando el modal de gestión está visible.
       - variantManagerMode: 'picker' (al cambiar de reporte) | 'manager' (acceso desde cabecera).
       - showVariantSaveModal: modal del flujo "Guardar como nueva variante".
       - variantsBusy: bloquea acciones mientras una operación apex está corriendo. */
    @track availableVariants = [];
    @track currentVariantId = null;
    @track showVariantManagerModal = false;
    @track variantManagerMode = 'manager';
    @track showVariantSaveModal = false;
    @track variantSaveDraft = { varianteId: '', nombre: '', esDefault: false, esPublica: true, activateAfterSave: true };
    @track variantsBusy = false;
    /* V-SEARCH: filtro del buscador del modal de variantes. Solo se muestra el input
       cuando hay suficientes variantes para que el filtrado tenga sentido (>=6). */
    @track variantSearchQuery = '';
    /* V-IMPORT: configuración leída desde archivo .json en espera de ser guardada como variante nueva.
       Cuando es null estamos en flujo "guardar config actual"; cuando es objeto estamos en "importar archivo". */
    @track _importedVariantConfig = null;
    @track _importedFromReportId = null;
    
    @track activeSheetId = null; @track selectedColumnApiName = null;
    @track fieldSearchTerm = ''; @track showNewSheetModal = false;
    @track newSheetName = 'Nueva hoja'; @track newSheetType = 'detail';
    
    @track draftSavedTime = null;
    /* F2: indicador moderno de auto-guardado.
       _lastSavedAt → timestamp ms del último save exitoso.
       _autosaveStatus → 'idle' | 'saving' | 'saved' | 'error'.
       _autosaveTick → contador que se incrementa cada 30s para forzar
       re-evaluación del getter autosaveStatusLabel (que muestra "hace Xs"). */
    @track _lastSavedAt = null;
    @track _autosaveStatus = 'idle';
    @track _autosaveTick = 0;
    _autosaveInterval = null;
    @track isLeftPanelHidden = false;
    @track isFullScreen = false; 
    /* Ola 2: tabs Diseño / Vista previa / Exportación. Por defecto Diseño = comportamiento actual. */
    @track activeStudioTab = 'design';
    /* Ola 3: sub-tabs del panel derecho (cuando hay hoja activa sin columna seleccionada). */
    @track activePanelTab = 'general';
    /* Ola 4: filtro del panel izquierdo (Todos / Seleccionados / Disponibles). */
    @track activeLeftTab = 'all';
    /* Estado transitorio para el drag-reorder dentro del panel izquierdo.
       dragOverPanelPosition: 'before' | 'after' según la mitad del item donde
       está el cursor; permite al usuario dejar caer el campo justo arriba o
       debajo del item objetivo. */
    @track dragOverPanelApiName = null;
    @track dragOverPanelPosition = null;
    /* B2: estado del drag-reorder de las pestañas inferiores de hojas. */
    @track draggedSheetId = null;
    @track dragOverSheetId = null;
    @track dragOverSheetPosition = null;
    /* B1: barra de búsqueda dentro de la tabla del lienzo central.
       Resalta las celdas cuyo texto contenga la cadena (case insensitive).
       Se abre con el botón o con Ctrl+Shift+F y se cierra con Escape. */
    @track isTableSearchOpen = false;
    @track tableSearchTerm = '';
    /* B5: menú contextual de filtros rápidos al hacer click derecho en una celda. */
    @track quickFilterMenuVisible = false;
    @track quickFilterMenuPos = '';
    @track quickFilterContext = null;
    /* B6: modo oscuro persistido en localStorage. */
    @track isDarkMode = false;
    /* R4: zoom de la vista previa. 50–200 en pasos de 10. Atajos Ctrl + / Ctrl − /
       Ctrl 0. Aplica con CSS `zoom: N` al wrapper del lienzo (Chrome/Edge/Safari/Firefox 126+). */
    @track previewZoom = 100;
    @track uiMode = 'basic';
    @track densityMode = 'comfortable';
    @track layoutPresetValue = '';

    @track isFloatingMenuVisible = false; @track floatingMenuPos = '';
    @track recentReports = [];
    /** @type {{ id: string, name: string }[]} */
    @track favoriteReportsList = [];
    @track serverTemplateExists = false;
    /** 'draft' | 'server' | 'default' — origen de la config aplicada al cargar */
    @track configLoadSource = 'default';
    @track lastTemplateSavedAt = null;
    /** Firma rápida de la última config sincronizada con servidor; '' si nunca se guardó. */
    @track _savedConfigSignature = '';

    @track showVirtualColModal = false;
    @track vcName = ''; @track vcType = 'text'; @track vcColA = ''; @track vcOp = ' - '; @track vcColB = ''; @track vcStaticB = '';
    @track vcRegexPattern = '';
    @track vcRegexFlags = '';
    @track vcCaptureGroup = '1';
    @track vcSplitDelimiter = '|';
    @track vcSplitPartIndex = '0';
    @track vcSubStart = '0';
    @track vcSubLength = '';
    @track editingVirtualApiName = null;

    @track reportContexts = {}; 
    @track showBlendModal = false;
    @track blendReportId = '';
    @track showStudioSettingsModal = false;
    @track showFiltersModal = false;

    @track isExporting = false;
    @track exportProgress = 0;
    @track exportStatusText = 'Preparando...';
    @track fetchStatusText = 'Analizando reporte...';
    autoExportAction = null; 

    isLoadingReports = true; isFetchingData = false; excelJsLoaded = false; pdfJsLoaded = false;
    excelJsLoading = false; pdfJsLoading = false;
    draggedApiName = null; draggedSource = null; 
    resizingColumnApiName = null; resizeStartX = 0; resizeStartWidth = 120; previewLimit = 10;
    resizingHeader = false; resizingRow = false; resizeStartY = 0; resizeStartHeight = 24;

    get fontOptions() {
        /** Nombres alineados con fuentes típicas de Excel/Office; vista previa web usa stacks CSS (formatThemeFontCss). */
        return [
            { label: 'Aptos (Office 365)', value: 'Aptos' },
            { label: 'Arial', value: 'Arial' },
            { label: 'Arial Black', value: 'Arial Black' },
            { label: 'Book Antiqua', value: 'Book Antiqua' },
            { label: 'Calibri', value: 'Calibri' },
            { label: 'Cambria', value: 'Cambria' },
            { label: 'Candara', value: 'Candara' },
            { label: 'Century Gothic', value: 'Century Gothic' },
            { label: 'Comic Sans MS', value: 'Comic Sans MS' },
            { label: 'Consolas', value: 'Consolas' },
            { label: 'Constantia', value: 'Constantia' },
            { label: 'Corbel', value: 'Corbel' },
            { label: 'Courier New', value: 'Courier New' },
            { label: 'Franklin Gothic Medium', value: 'Franklin Gothic Medium' },
            { label: 'Garamond', value: 'Garamond' },
            { label: 'Georgia', value: 'Georgia' },
            { label: 'Impact', value: 'Impact' },
            { label: 'Lucida Console', value: 'Lucida Console' },
            { label: 'Palatino Linotype', value: 'Palatino Linotype' },
            { label: 'Segoe UI', value: 'Segoe UI' },
            { label: 'Tahoma', value: 'Tahoma' },
            { label: 'Times New Roman', value: 'Times New Roman' },
            { label: 'Trebuchet MS', value: 'Trebuchet MS' },
            { label: 'Verdana', value: 'Verdana' },
            { label: 'Helvetica Neue (si está instalada)', value: 'Helvetica Neue' },
        ];
    }

    normalizeThemeFontName(name, fallback = 'Calibri') {
        const raw = String(name ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '');
        if (!raw) return fallback;
        const match = this.fontOptions.find(o => o.value.toLowerCase() === raw.toLowerCase());
        return match ? match.value : raw;
    }

    /** `font-family` para estilos inline en la vista previa (entrecomilla y reservas claras por categoría). */
    formatThemeFontCss(name) {
        const canon = this.normalizeThemeFontName(name);
        const q = '"';
        const quoted = `${q}${canon.replace(/"/g, '\\"')}${q}`;
        const key = canon.toLowerCase();
        const mono = new Set(['consolas', 'courier new', 'courier', 'lucida console']);
        const serif = new Set(['times new roman', 'times', 'book antiqua', 'cambria', 'constantia', 'garamond', 'georgia', 'palatino linotype']);
        if (mono.has(key)) return `${quoted}, "Courier New", Consolas, ui-monospace, monospace`;
        if (serif.has(key)) return `${quoted}, Cambria, Georgia, "Times New Roman", serif`;
        return `${quoted}, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    }

    /** jsPDF solo incluye helvetica / times / courier — aproximación estable según la fuente elegida. */
    resolvePdfBuiltinFont(themeFontName) {
        const canon = this.normalizeThemeFontName(themeFontName);
        const key = canon.toLowerCase();
        const mono = new Set(['consolas', 'courier new', 'courier', 'lucida console']);
        const serif = new Set(['times new roman', 'times', 'book antiqua', 'cambria', 'constantia', 'garamond', 'georgia', 'palatino linotype']);
        if (mono.has(key)) return 'courier';
        if (serif.has(key)) return 'times';
        return 'helvetica';
    }
    get operationOptions() { return [{ label: 'Recuento (Count)', value: 'COUNT' }, { label: 'Suma (Sum)', value: 'SUM' }, { label: 'Promedio (Avg)', value: 'AVG' }]; }
    get orientationOptions() { return [{ label: 'Vertical (Clásica)', value: 'vertical' }, { label: 'Horizontal (Transpuesta)', value: 'horizontal' }]; }
    get leftPanelIcon() { return this.isLeftPanelHidden ? 'utility:chevronright' : 'utility:chevronleft'; }
    get fullScreenIcon() { return this.isFullScreen ? 'utility:contract_alt' : 'utility:expand_alt'; }
    get appContainerClass() {
        let base = this.isFullScreen ? 'pandora-app is-fullscreen' : 'pandora-app';
        if (this.densityMode === 'compact') base += ' density-compact';
        if (this.isDarkMode) base += ' pandora-app--dark';
        return base;
    }
    get dynamicLayoutStyle() { return this.isLeftPanelHidden ? 'grid-template-columns: minmax(0, 1fr) 340px;' : 'grid-template-columns: 360px minmax(0, 1fr) 340px;'; }

    /* R4: zoom de la vista previa.
       Aplicamos `zoom: N` al .excel-canvas-zoom-wrap. `zoom` mantiene el
       layout y los scrolls del contenedor padre (.excel-canvas) intactos,
       lo cual evita los típicos problemas de transform: scale. */
    get previewZoomStyle() { return `zoom: ${(this.previewZoom || 100) / 100};`; }
    get previewZoomLabel() { return `${this.previewZoom || 100}%`; }
    get canZoomIn()  { return (this.previewZoom || 100) < 200; }
    get canZoomOut() { return (this.previewZoom || 100) > 50;  }
    get cantZoomIn()  { return !this.canZoomIn;  }
    get cantZoomOut() { return !this.canZoomOut; }
    _clampZoom(z) { z = Math.round((Number(z) || 100) / 10) * 10; if (z < 50) z = 50; if (z > 200) z = 200; return z; }
    handleZoomIn()    { this.previewZoom = this._clampZoom((this.previewZoom || 100) + 10); }
    handleZoomOut()   { this.previewZoom = this._clampZoom((this.previewZoom || 100) - 10); }
    handleZoomReset() { this.previewZoom = 100; }

    /* ─── Ola 2: tabs Diseño / Vista previa / Exportación ─────────────
       Estos getters son derivados de activeStudioTab; no tocan ninguna
       propiedad ya existente. La vista "Diseño" reusa exactamente el
       comportamiento previo (mismo style inline, mismos paneles). Las
       otras dos vistas son aditivas y se pueden ignorar sin riesgo. */
    get isStudioTabDesign()  { return this.activeStudioTab === 'design';  }
    get isStudioTabPreview() { return this.activeStudioTab === 'preview'; }
    get isStudioTabExport()  { return this.activeStudioTab === 'export';  }
    get studioTabDesignClass()  { return 'studio-tab' + (this.isStudioTabDesign  ? ' studio-tab--active' : ''); }
    get studioTabPreviewClass() { return 'studio-tab' + (this.isStudioTabPreview ? ' studio-tab--active' : ''); }
    get studioTabExportClass()  { return 'studio-tab' + (this.isStudioTabExport  ? ' studio-tab--active' : ''); }
    /* En "Vista previa" colapsamos el grid a una sola columna para que el lienzo central
       ocupe todo el ancho cuando los paneles laterales esten ocultos por CSS. */
    get studioLayoutClass() {
        return this.isStudioTabPreview ? 'studio-layout studio-layout--preview' : 'studio-layout';
    }
    get studioLayoutStyle() {
        if (this.isStudioTabPreview) return 'grid-template-columns: minmax(0, 1fr);';
        return this.dynamicLayoutStyle;
    }
    setStudioTab(event) {
        const tab = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.tab;
        if (!tab || tab === this.activeStudioTab) return;
        this.activeStudioTab = tab;
        /* Al saltar a Vista previa, salir del menu contextual flotante (si esta abierto)
           para evitar que quede flotando sobre un lienzo distinto. */
        if (tab === 'preview' && this.isFloatingMenuVisible) {
            this.isFloatingMenuVisible = false;
        }
    }
    /* Handler unico para los botones del tab "Exportacion". Reusa las funciones que ya
       existen (avanzarAPpt, generarExcelLocal, generarPdfLocal, exportReportConfigToFile)
       sin duplicar logica. */
    exportFromTab(event) {
        const action = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.action;
        if (!action) return;
        switch (action) {
            case 'ppt':    this.avanzarAPpt(); break;
            case 'excel':  this.generarExcelLocal(); break;
            case 'pdf':    this.generarPdfLocal(); break;
            case 'config': this.exportReportConfigToFile(); break;
            default: break;
        }
    }

    /* ─── Ola 3: sub-tabs del panel derecho ───────────────────────────
       Reorganizan visualmente los bloques de configuracion de hoja en
       4 grupos: General / Formato / Filtros / Exportacion. No tocan
       ningun handler ni propiedad existente: solo controlan que tab
       muestra cada bloque. */
    get isPanelTabGeneral() { return this.activePanelTab === 'general'; }
    get isPanelTabFormato() { return this.activePanelTab === 'formato'; }
    get isPanelTabFiltros() { return this.activePanelTab === 'filtros'; }
    get isPanelTabExport()  { return this.activePanelTab === 'export';  }
    get panelTabGeneralClass() { return 'panel-subtab' + (this.isPanelTabGeneral ? ' panel-subtab--active' : ''); }
    get panelTabFormatoClass() { return 'panel-subtab' + (this.isPanelTabFormato ? ' panel-subtab--active' : ''); }
    get panelTabFiltrosClass() { return 'panel-subtab' + (this.isPanelTabFiltros ? ' panel-subtab--active' : ''); }
    get panelTabExportClass()  { return 'panel-subtab' + (this.isPanelTabExport  ? ' panel-subtab--active' : ''); }
    /* Mensaje para la tab Formato cuando no aplica nada (hoja resumen + modo basico). */
    get showPanelFormatoEmpty() { return !this.isTableSheet && !this.isAdvancedMode; }
    /* Mensaje para la tab Exportacion cuando no estamos en modo libro (no hay pivots/blending). */
    get showPanelExportEmpty()  { return !this.isAdvancedMode; }
    setPanelTab(event) {
        const tab = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.paneltab;
        if (!tab || tab === this.activePanelTab) return;
        this.activePanelTab = tab;
    }

    /* ─── Ola 4: tabs del panel izquierdo (Todos / Seleccionados / Disponibles)
       y breadcrumb del canvas. NO modifica filteredAvailableColumns para evitar
       efectos colaterales en otros sitios; añado un getter wrapper. ─────────── */
    get isLeftTabAll()        { return this.activeLeftTab === 'all'; }
    get isLeftTabSelected()   { return this.activeLeftTab === 'selected'; }
    get isLeftTabAvailable()  { return this.activeLeftTab === 'available'; }
    get leftTabAllClass()       { return 'left-tab' + (this.isLeftTabAll       ? ' left-tab--active' : ''); }
    get leftTabSelectedClass()  { return 'left-tab' + (this.isLeftTabSelected  ? ' left-tab--active' : ''); }
    get leftTabAvailableClass() { return 'left-tab' + (this.isLeftTabAvailable ? ' left-tab--active' : ''); }
    /* Conteos para los badges de los tabs y el breadcrumb. */
    get availableColumnsCount() {
        if (!this.activeSheet || !this.activeSheet.columns) return 0;
        return this.activeSheet.columns.filter(c => !c.visible).length;
    }
    get totalColumnsCount() {
        return (this.baseColumns && this.baseColumns.length) ? this.baseColumns.length : 0;
    }
    /* Vista filtrada para el panel izquierdo: aplica search + tab. El orden
       se aplica a través de orderedBaseColumns, que ahora lee column.order
       de activeSheet.columns (mismo orden que la tabla central y los exports). */
    get displayedLeftPanelColumns() {
        let list = this.filteredAvailableColumns;
        if (this.isLeftTabSelected)  list = list.filter(c => c.visible);
        if (this.isLeftTabAvailable) list = list.filter(c => !c.visible);
        /* Drop indicator: dibujamos una línea arriba o abajo del item objetivo
           según la mitad del rect donde está el cursor (more fine-grained UX). */
        if (this.dragOverPanelApiName) {
            const dropClass = this.dragOverPanelPosition === 'after'
                ? 'field-item--drop-after'
                : 'field-item--drop-before';
            list = list.map(c => c.apiName === this.dragOverPanelApiName
                ? { ...c, cardClass: `${c.cardClass} ${dropClass}` }
                : c);
        }
        return list;
    }

    /* ─── Formato de fecha por columna ─────────────────────────────────
       Permite forzar DD/MM/YYYY, MM/DD/YYYY o YYYY-MM-DD en columnas
       fecha. Por defecto ('auto') usa el locale del navegador (lo que
       hace hoy). El override aplica tanto a la vista previa como al
       export Excel/PDF (numFmt / texto del PDF). */
    get dateFormatOptions() {
        return [
            { label: 'Predeterminado del sistema',     value: 'auto' },
            { label: 'DD/MM/YYYY  (ej. 23/04/2026)',   value: 'dmy'  },
            { label: 'MM/DD/YYYY  (ej. 04/23/2026)',   value: 'mdy'  },
            { label: 'YYYY-MM-DD  (ISO)',              value: 'ymd'  },
            { label: 'DD MMM YYYY  (ej. 23 abr 2026)', value: 'long' }
        ];
    }
    /* True si la columna seleccionada es de tipo fecha. Detección permisiva:
       - dataType DATE/DATETIME (caso ideal cuando Salesforce devuelve el tipo).
       - format manual 'date' o 'datetime' (cuando el usuario fuerza el formato).
       - Heurística por label/apiName: muchos reportes traen dataType STRING
         para campos que sí son fechas. Detectamos palabras comunes en
         español/inglés para que el combobox aparezca sin tener que cambiar
         primero el formato de datos. */
    get isSelectedColumnDateLike() {
        const c = this.selectedColumn;
        if (!c) return false;
        const dt = (c.dataType || '').toUpperCase();
        if (dt === 'DATE' || dt === 'DATETIME') return true;
        if (c.format === 'date' || c.format === 'datetime') return true;
        const hay = `${c.apiName || ''} ${c.label || ''}`.toLowerCase();
        const tokens = ['fecha', 'date', 'creación', 'creacion', 'modific', 'closed', 'opened', 'cierre', 'apertura'];
        return tokens.some(t => hay.includes(t));
    }
    /* Formatea un objeto Date para mostrar en el preview (la celda HTML).
       Si mode === 'auto' o desconocido, devuelve toLocaleString del navegador. */
    _formatDateForPreview(dateObj, mode, dataType) {
        if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return dateObj;
        const pad = (n) => String(n).padStart(2, '0');
        const yyyy = dateObj.getFullYear();
        const mm = pad(dateObj.getMonth() + 1);
        const dd = pad(dateObj.getDate());
        const isDateTime = (String(dataType || '').toUpperCase() === 'DATETIME');
        const hh = pad(dateObj.getHours());
        const mi = pad(dateObj.getMinutes());
        const timePart = isDateTime ? ` ${hh}:${mi}` : '';
        switch (mode) {
            case 'dmy':  return `${dd}/${mm}/${yyyy}${timePart}`;
            case 'mdy':  return `${mm}/${dd}/${yyyy}${timePart}`;
            case 'ymd':  return `${yyyy}-${mm}-${dd}${timePart}`;
            case 'long': {
                const monthNames = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
                return `${dd} ${monthNames[dateObj.getMonth()]} ${yyyy}${timePart}`;
            }
            case 'auto':
            default: {
                /* Locale-aware con padding forzado: usamos Intl con day/month '2-digit'
                   para evitar el comportamiento de toLocaleDateString() en locales
                   como es-CL o es-ES, que retornan "4/1/2025" sin ceros a la izquierda.
                   Si Intl falla, caemos a DD/MM/YYYY desde nuestros pads internos. */
                try {
                    const opts = isDateTime
                        ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
                        : { day: '2-digit', month: '2-digit', year: 'numeric' };
                    return new Intl.DateTimeFormat(undefined, opts).format(dateObj);
                } catch (e) {
                    return `${dd}/${mm}/${yyyy}${timePart}`;
                }
            }
        }
    }
    /* numFmt de Excel para fechas según el mode elegido. */
    _excelNumFmtForDate(mode, isDateTime) {
        let base;
        switch (mode) {
            case 'dmy':  base = 'dd/mm/yyyy'; break;
            case 'mdy':  base = 'mm/dd/yyyy'; break;
            case 'ymd':  base = 'yyyy-mm-dd'; break;
            case 'long': base = 'dd-mmm-yyyy'; break;
            case 'auto':
            default:     base = isDateTime ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy'; break;
        }
        if (isDateTime && !/hh:?mm/i.test(base)) base += ' hh:mm';
        return base;
    }
    /* Mensaje cuando la combinación tab+search no devuelve nada. */
    get leftPanelEmptyMessage() {
        if ((this.fieldSearchTerm || '').trim().length) {
            return 'No hay campos que coincidan con la búsqueda.';
        }
        if (this.isLeftTabSelected)  return 'Aún no has activado ninguna columna en esta hoja.';
        if (this.isLeftTabAvailable) return 'Todas las columnas ya están activas en esta hoja.';
        return 'Este reporte aún no tiene columnas.';
    }
    get hasDisplayedLeftPanelColumns() {
        return this.displayedLeftPanelColumns.length > 0;
    }
    /* Breadcrumb del canvas: "Tabla detalle · N columnas · M filtros". */
    get canvasBreadcrumbColumnsLabel() {
        const n = this.visibleColumnsCount;
        return n === 1 ? '1 columna' : `${n} columnas`;
    }
    get canvasBreadcrumbFiltersLabel() {
        const n = this.activeFilterCount;
        return n === 1 ? '1 filtro' : `${n} filtros`;
    }
    get hasCanvasBreadcrumbFilters() { return this.activeFilterCount > 0; }
    /* Ver conteo de registros: cuenta filas reales (tras filtros) del reporte para
       mostrarlas como chip en el breadcrumb del lienzo. Solo aplica para hojas
       tipo "detail" donde tiene sentido el conteo. */
    get showRowCountChecked() {
        return !!(this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.showRowCount);
    }
    get canvasBreadcrumbRowsLabel() {
        if (!this.showRowCountChecked || !this.isTableSheet) return '';
        const parsed = this.getParsedReportData();
        if (!parsed) return '';
        const rows = getRowsForSheet(this.activeSheet, parsed);
        const n = (rows && rows.length) ? rows.length : 0;
        try {
            return n === 1 ? '1 registro' : `${n.toLocaleString()} registros`;
        } catch (_e) {
            return n === 1 ? '1 registro' : `${n} registros`;
        }
    }
    get hasCanvasBreadcrumbRows() { return !!this.canvasBreadcrumbRowsLabel; }
    setLeftTab(event) {
        const tab = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.lefttab;
        if (!tab || tab === this.activeLeftTab) return;
        this.activeLeftTab = tab;
    }

    get vcTypeOptions() {
        return [
            { label: 'Unir Textos (Concatenar)', value: 'text' },
            { label: 'Fórmula Matemática', value: 'math' },
            { label: 'Extraer texto (expresión regular)', value: 'regex' },
            { label: 'Primer bloque fecha/hora (histórico en un mismo campo)', value: 'firstTimestampBlock' },
            { label: 'Dividir y elegir parte', value: 'split' },
            { label: 'Subcadena (inicio / longitud)', value: 'substring' }
        ];
    }
    /* Versión enriquecida para renderizar como cards radio en el modal:
       conserva exactamente los mismos valores que vcTypeOptions para no romper la lógica. */
    get vcTypeChoices() {
        const defs = [
            { value: 'text',                title: 'Unir campos',           icon: 'utility:merge',          hint: 'Concatena valores de columnas con un separador (espacio, guion, coma…) o un texto fijo.' },
            { value: 'math',                title: 'Fórmula matemática',    icon: 'utility:formula',        hint: 'Suma, resta, multiplica o divide dos columnas numéricas o una columna y un valor.' },
            { value: 'split',               title: 'Dividir texto',         icon: 'utility:chop',           hint: 'Separa el texto por un delimitador y elige el fragmento que necesitas.' },
            { value: 'substring',           title: 'Subcadena',             icon: 'utility:text',           hint: 'Recorta el texto por posición (inicio y longitud, base 0 estilo JavaScript).' },
            { value: 'regex',               title: 'Extraer (regex)',       icon: 'utility:search',         hint: 'Busca un patrón en el texto y extrae la parte que matchea.' },
            { value: 'firstTimestampBlock', title: 'Primer bloque fecha',   icon: 'utility:date_time',      hint: 'Útil cuando un campo acumula entradas con timestamp: deja solo el primer bloque.' }
        ];
        return defs.map(d => ({
            ...d,
            isActive: this.vcType === d.value,
            cardClass: this.vcType === d.value ? 'vc-type-card vc-type-card--active' : 'vc-type-card'
        }));
    }
    setVcType(event) {
        const v = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.vctype;
        if (!v || v === this.vcType) return;
        this.vcType = v;
        /* Mantener el comportamiento del combobox actual: reset del separador/operador. */
        this.vcOp = v === 'math' ? '+' : ' - ';
    }
    /* Construye un vcDef provisional con los valores actuales del modal.
       Espejo de la lógica de saveVirtualColumn pero sin validaciones bloqueantes:
       si algo falta, devuelve null y el preview no se muestra. */
    get vcCurrentDef() {
        if (!this.vcColA) return null;
        const t = this.vcType;
        try {
            if (t === 'regex') {
                if (!this.vcRegexPattern) return null;
                /* Compilamos para verificar; si falla, no devolvemos def (no rompemos el modal). */
                RegExp(String(this.vcRegexPattern), this.vcRegexFlags || '');
                const cg = Number(this.vcCaptureGroup);
                return { type: 'regex', colA: this.vcColA, pattern: String(this.vcRegexPattern), flags: String(this.vcRegexFlags || ''), captureGroup: Number.isFinite(cg) ? cg : 1 };
            }
            if (t === 'split') {
                return { type: 'split', colA: this.vcColA, delimiter: this.vcSplitDelimiter != null ? String(this.vcSplitDelimiter) : ',', partIndex: Number.isFinite(Number(this.vcSplitPartIndex)) ? Number(this.vcSplitPartIndex) : 0 };
            }
            if (t === 'substring') {
                const start = Number.isFinite(Number(this.vcSubStart)) ? Number(this.vcSubStart) : 0;
                const lenRaw = String(this.vcSubLength ?? '').trim();
                let length;
                if (lenRaw === '') length = undefined;
                else { const ln = Number(lenRaw); length = Number.isFinite(ln) && ln >= 0 ? ln : undefined; }
                return { type: 'substring', colA: this.vcColA, start: Math.max(0, start), length };
            }
            if (t === 'firstTimestampBlock') {
                return { type: 'firstTimestampBlock', colA: this.vcColA };
            }
            return { type: t, colA: this.vcColA, op: this.vcOp, colB: this.vcColB, staticB: this.vcStaticB };
        } catch (e) {
            return null;
        }
    }
    /* Vista previa en vivo: primeras 3 filas calculadas con la config actual.
       Si no hay hoja activa o el def no está listo, retorna []. */
    get vcPreviewRows() {
        if (!this.showVirtualColModal) return [];
        const def = this.vcCurrentDef;
        if (!def) return [];
        const parsedData = this.getParsedReportData();
        if (!parsedData || !this.activeSheet) return [];
        const rows = getRowsForSheet(this.activeSheet, parsedData).slice(0, 3);
        if (!rows.length) return [];
        const virtualCol = { apiName: '__vc_preview__', isVirtual: true, vcDef: def };
        return rows.map((r, i) => {
            let value;
            try {
                const cellData = computeVirtualCellValue(r, virtualCol, parsedData);
                value = cellData && (cellData.label != null ? cellData.label : cellData.value);
                if (value == null) value = '';
            } catch (e) {
                value = '(error en cálculo)';
            }
            return { key: `vc_prev_${i}`, value: String(value) };
        });
    }
    get vcHasPreview() { return this.vcPreviewRows.length > 0; }
    /* Hint corto para mostrar arriba del lienzo de configuración según el modo activo. */
    get vcModeHint() {
        const c = this.vcTypeChoices.find(x => x.isActive);
        return c ? c.hint : '';
    }

    get vcShowFirstTimestampBlockHint() { return this.vcType === 'firstTimestampBlock'; }
    get virtualModalTitle() { return this.editingVirtualApiName ? '✏️ Editar Columna Virtual' : '✨ Nueva Columna Virtual'; }

    get vcShowComposeRow() { return this.vcType === 'text' || this.vcType === 'math'; }
    get vcShowRegexFields() { return this.vcType === 'regex'; }
    get vcShowSplitFields() { return this.vcType === 'split'; }
    get vcShowSubstringFields() { return this.vcType === 'substring'; }
    get baseColumnsOptions() { return this.baseColumns.map(c => ({ label: c.label, value: c.apiName })); }
    get vcOpOptions() { return this.vcType === 'math' ? [{label:'Suma (+)', value:'+'},{label:'Resta (-)', value:'-'},{label:'Multiplicar (*)', value:'*'},{label:'Dividir (/)', value:'/'}] : [{label:'Espacio', value:' '},{label:'Guion (-)', value:' - '},{label:'Coma (,)', value:', '},{label:'Sin espacio', value:''}]; }
    get vcOpLabel() { return this.vcType === 'math' ? 'Operación Matemática' : 'Separador de Texto'; }
    get progressBarStyle() { return `width: ${this.exportProgress}%;`; }

    // NUEVAS OPCIONES DE FORMATO Y ORDEN
    get formatOptions() { return [{ label: 'Automático', value: 'auto' }, { label: 'Texto', value: 'text' }, { label: 'Número', value: 'number' }, { label: 'Moneda', value: 'currency' }, { label: 'Porcentaje', value: 'percent' }, { label: 'Fecha', value: 'date' }]; }
    /* Versión visual del selector de formato como chips de radio. Reusa los
       mismos valores que formatOptions (auto/text/number/currency/percent/date)
       y dispara el mismo handler que el combobox anterior, pero con icono
       grande para identificar de un vistazo el tipo de formato aplicado. */
    get formatChoices() {
        const c = this.selectedColumn;
        const active = c ? (c.format || 'auto') : 'auto';
        const defs = [
            { value: 'auto',     label: 'Auto',       icon: 'utility:magicwand',    hint: 'Detecta el formato según el tipo de campo del reporte.' },
            { value: 'text',     label: 'Texto',      icon: 'utility:text',         hint: 'Trata el valor como texto plano.' },
            { value: 'number',   label: 'Número',     icon: 'utility:number_input', hint: 'Número con separadores de miles.' },
            { value: 'currency', label: 'Moneda',     icon: 'utility:currency',     hint: 'Formato de moneda.' },
            { value: 'percent',  label: 'Porcentaje', icon: 'utility:percent',      hint: 'Formato de porcentaje.' },
            { value: 'date',     label: 'Fecha',      icon: 'utility:date_input',   hint: 'Formatea como fecha (usa "Formato de fecha" para personalizar).' }
        ];
        return defs.map(d => ({
            ...d,
            isActive: active === d.value,
            ariaChecked: active === d.value ? 'true' : 'false',
            chipClass: active === d.value ? 'format-chip format-chip--active' : 'format-chip'
        }));
    }
    setFormatChoice(event) {
        if (!this.selectedColumnApiName) return;
        const v = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.format;
        if (!v) return;
        this.updateActiveSheetColumn(this.selectedColumnApiName, { format: v });
    }
    get sortDirectionOptions() { return [{ label: 'Ascendente (A-Z, 0-9)', value: 'ASC' }, { label: 'Descendente (Z-A, 9-0)', value: 'DESC' }]; }
    get pivotSortByOptions() { return [{ label: 'Categoría (Alfabético)', value: 'LABEL' }, { label: 'Valor (Numérico)', value: 'VALUE' }]; }
    get filterLogicOptions() { return [{ label: 'Y (AND)', value: 'AND' }, { label: 'O (OR)', value: 'OR' }]; }

    get previewTableOffsetStyle() {
        if (!this.activeSheet || !this.activeSheet.settings) return '';
        const s = this.activeSheet.settings;
        /* Preview WYSIWYG: reservamos el espacio bajo el logo usando los px reales
           del logo (logoY + logoHeight + 16px de padding). Esto evita que la tabla
           "salte" muy abajo cuando el logo se arrastra y, a la vez, garantiza que
           nunca se solape con el logo. Solo aplica si hay logo cargado.
           Para el Excel y PDF se usa getEffectiveExcelTableStartRow aparte. */
        let logoSpacerPx = 0;
        if (s.logoBase64) {
            const logoY = this._effectiveLogoY(s);
            const logoH = Number(s.logoHeight) || 45;
            logoSpacerPx = Math.max(0, logoY + logoH + 16);
        }
        /* tableStartRow (legacy) sigue sumando filas vacías opcionales. */
        const startRow = Math.max(1, Number(s.tableStartRow) || 1);
        const rowHeight = Number(s.dataRowHeight) || 24;
        const explicitSpacerPx = (startRow - 1) * rowHeight;
        const totalSpacerPx = Math.max(logoSpacerPx, explicitSpacerPx);

        /* V5: tableOffsetX / tableOffsetY permiten mover la tabla por el lienzo. */
        const baseOx = parseInt(s.tableOffsetX, 10) || 0;
        const baseOy = parseInt(s.tableOffsetY, 10) || 0;
        const ox = baseOx + (this._tableDragDeltaX || 0);
        const oy = baseOy + (this._tableDragDeltaY || 0);
        const transform = (ox || oy) ? ` transform: translate(${ox}px, ${oy}px);` : '';
        return `margin-top: ${totalSpacerPx}px; transition: ${this._tableDragging ? 'none' : 'margin 0.3s ease, transform 0.15s ease'};${transform}`;
    }
    /* V5: estado del modo "mover tabla" + drag handlers. */
    @track isMovingTable = false;
    @track _tableDragging = false;
    @track _tableDragDeltaX = 0;
    @track _tableDragDeltaY = 0;
    _tableDragStart = null;
    toggleMoveTableMode() {
        this.isMovingTable = !this.isMovingTable;
        if (!this.isMovingTable) {
            this._tableDragging = false;
            this._tableDragDeltaX = 0;
            this._tableDragDeltaY = 0;
        }
    }
    resetTableOffset() {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, tableOffsetX: 0, tableOffsetY: 0 } });
    }
    handleTableMoveMouseDown(event) {
        if (!this.isMovingTable) return;
        event.preventDefault();
        event.stopPropagation();
        this._tableDragStart = { x: event.clientX, y: event.clientY };
        this._tableDragging = true;
        this._tableDragDeltaX = 0;
        this._tableDragDeltaY = 0;
        this._boundTableMoveMove = this._onTableMoveMouseMove.bind(this);
        this._boundTableMoveUp   = this._onTableMoveMouseUp.bind(this);
        document.addEventListener('mousemove', this._boundTableMoveMove, false);
        document.addEventListener('mouseup',   this._boundTableMoveUp,   false);
    }
    _onTableMoveMouseMove(event) {
        if (!this._tableDragging || !this._tableDragStart) return;
        this._tableDragDeltaX = event.clientX - this._tableDragStart.x;
        this._tableDragDeltaY = event.clientY - this._tableDragStart.y;
    }
    _onTableMoveMouseUp() {
        if (this._tableDragging && this.activeSheet) {
            const baseOx = parseInt(this.activeSheet.settings.tableOffsetX, 10) || 0;
            const baseOy = parseInt(this.activeSheet.settings.tableOffsetY, 10) || 0;
            const ox = Math.max(-600, Math.min(1200, baseOx + this._tableDragDeltaX));
            const oy = Math.max(-200, Math.min(1200, baseOy + this._tableDragDeltaY));
            this.updateActiveSheet({ settings: { ...this.activeSheet.settings, tableOffsetX: Math.round(ox), tableOffsetY: Math.round(oy) } });
        }
        this._tableDragging = false;
        this._tableDragDeltaX = 0;
        this._tableDragDeltaY = 0;
        this._tableDragStart = null;
        if (this._boundTableMoveMove) document.removeEventListener('mousemove', this._boundTableMoveMove, false);
        if (this._boundTableMoveUp)   document.removeEventListener('mouseup',   this._boundTableMoveUp,   false);
        this._boundTableMoveMove = null;
        this._boundTableMoveUp = null;
    }
    get moveTableBtnClass() { return this.isMovingTable ? 'canvas-zoom-btn canvas-zoom-btn--active' : 'canvas-zoom-btn'; }
    get moveTableBtnTitle() { return this.isMovingTable ? 'Modo mover activo. Click para salir.' : 'Mover tabla por el lienzo'; }
    get hasTableOffset() {
        if (!this.activeSheet || !this.activeSheet.settings) return false;
        const ox = parseInt(this.activeSheet.settings.tableOffsetX, 10) || 0;
        const oy = parseInt(this.activeSheet.settings.tableOffsetY, 10) || 0;
        return ox !== 0 || oy !== 0;
    }
    get previewTableShellWrapClass() {
        return this.isMovingTable ? 'preview-table-mover preview-table-mover--active' : 'preview-table-mover';
    }

    /* Y1: posición libre del logo en el lienzo. logoX/logoY se persisten en píxeles
       y se sincronizan con logoCol/logoRow (legacy) por compatibilidad. Durante un
       drag activo, aplicamos un delta provisional sin commitear al state. */
    get previewLogoContainerStyle() {
        if (!this.activeSheet || !this.activeSheet.settings || !this.activeSheet.settings.logoBase64) return '';
        const s = this.activeSheet.settings;
        const baseX = this._effectiveLogoX(s);
        const baseY = this._effectiveLogoY(s);
        const x = baseX + (this._logoDragDeltaX || 0);
        const y = baseY + (this._logoDragDeltaY || 0);
        return `position: absolute; left: ${x}px; top: ${y}px; z-index: 10; transition: ${(this._logoDragging || this._logoResizing) ? 'none' : 'left 0.15s ease, top 0.15s ease, width 0.15s ease, height 0.15s ease'};`;
    }
    get previewLogoImgStyle() {
        if (!this.activeSheet || !this.activeSheet.settings) return '';
        const s = this.activeSheet.settings;
        const w = Math.max(20, (Number(s.logoWidth)  || 140) + (this._logoResizeDeltaW || 0));
        const h = Math.max(20, (Number(s.logoHeight) || 45)  + (this._logoResizeDeltaH || 0));
        return `width: ${w}px; height: ${h}px; object-fit: contain; display:block; pointer-events:none;`;
    }
    _effectiveLogoX(s) {
        if (s.logoX != null) return Number(s.logoX) || 0;
        /* Fallback legacy: deducir de logoCol (A → 0, B → 120 px, …). */
        const colLetter = (s.logoCol || 'A').toUpperCase();
        const colIndex = Math.max(0, Math.min(25, colLetter.charCodeAt(0) - 65));
        return 16 + colIndex * 120;
    }
    _effectiveLogoY(s) {
        if (s.logoY != null) return Number(s.logoY) || 0;
        const rowNum = Number(s.logoRow) || 1;
        return 16 + Math.max(0, (rowNum - 1) * (s.dataRowHeight || 24));
    }

    /** Opciones solo para la vista previa y estilos de celda coherentes con la tabla del lienzo */
    get previewFontScaleOptions() {
        return [
            { label: 'Predeterminado', value: 'standard' },
            { label: 'Compacto (más filas)', value: 'compact' },
            { label: 'Cómodo', value: 'large' },
        ];
    }

    blankHyphenDisplaysAsEmpty(sheet) {
        const sh = sheet || this.activeSheet;
        return sh?.settings?.blankHyphenAsEmpty !== false;
    }

    /** Salesforce a veces devuelve guión tipográfico o «-» cuando no hay texto; opcionalmente se muestra celda vacía. */
    normalizeBlankDisplayString(val, enabled) {
        if (!enabled) return val === undefined ? '' : val;
        if (val === null || val === undefined) return '';
        if (typeof val !== 'string') return val;
        const t = val.trim();
        if (t === '') return '';
        /* Guiones típicos de Salesforce / UI como marcador de vacío */
        if (/^[\-\u2010\u2011\u2012\u2013\u2014\u2212]+$/.test(t)) return '';
        return val;
    }

    /** Clases del lienzo. U2: el "aspecto Excel" se aplica SIEMPRE para que el
        preview coincida visualmente con la exportación Excel/PDF (toggle eliminado). */
    get excelPreviewCanvasClasses() {
        const parts = ['excel-canvas', 'excel-like-canvas-theme'];
        const sh = this.activeSheet && this.activeSheet.settings;
        if (sh) {
            const scale = sh.previewFontScale === 'compact' || sh.previewFontScale === 'large' ? sh.previewFontScale : 'standard';
            if (scale === 'compact') parts.push('excel-preview-font--compact');
            else if (scale === 'large') parts.push('excel-preview-font--large');
        }
        return parts.join(' ');
    }

    get excelPreviewTableShellClass() {
        return 'preview-table-shell preview-table-shell--excel';
    }

    get excelPreviewMainTableClass() {
        const parts = ['preview-table', 'preview-table--excel-grid'];
        const s = this.activeSheet?.settings;
        if (s && s.previewCellWrapWords) parts.push('preview-table--wrap-text');
        return parts.join(' ');
    }

    get activePreviewFontScaleValue() {
        const s = this.activeSheet?.settings?.previewFontScale;
        return s === 'compact' || s === 'large' ? s : 'standard';
    }

    /** checked binding: valores vacíos muestran celda sin guión (solo vista previa y export donde se usa getExcelValue) */
    get blankHyphenAsEmptyChecked() {
        return this.activeSheet?.settings?.blankHyphenAsEmpty !== false;
    }

    get alignVariantLeft() { return this.selectedColumn && this.selectedColumn.alignment === 'left' ? 'brand' : 'border-filled'; }
    get alignVariantCenter() { return this.selectedColumn && this.selectedColumn.alignment === 'center' ? 'brand' : 'border-filled'; }
    get alignVariantRight() { return this.selectedColumn && this.selectedColumn.alignment === 'right' ? 'brand' : 'border-filled'; }
    get hasRecentReports() { return this.recentReports && this.recentReports.length > 0; }
    get hasRecentForQuickAccess() { return this.recentReportsForHome && this.recentReportsForHome.length > 0; }
    get hasFavoriteReports() { return this.favoriteReportsList && this.favoriteReportsList.length > 0; }
    get favoriteIdSet() {
        return new Set((this.favoriteReportsList || []).map(f => f.id));
    }
    get favoriteCardsForHome() {
        return (this.favoriteReportsList || []).map(f => {
            const opt = this.reportOptions.find(o => o.value === f.id);
            return {
                id: f.id,
                name: opt ? opt.label : f.name,
                key: `fav_${f.id}`
            };
        });
    }
    get recentReportsForHome() {
        const fav = this.favoriteIdSet;
        return (this.recentReports || []).filter(r => !fav.has(r.id)).map(r => ({
            ...r,
            key: `recent_${r.id}`
        }));
    }
    get showTemplateSyncInHeader() { return !!this.selectedReportId && !this.isFetchingData; }
    get templateStatusShortLabel() {
        if (this.configLoadSource === 'draft' && this.serverTemplateExists) return 'Borrador + servidor';
        if (this.configLoadSource === 'draft') return 'Solo borrador local';
        if (this.configLoadSource === 'server') return 'Plantilla Salesforce';
        return 'Config. nueva';
    }
    get templateStatusTitle() {
        switch (this.configLoadSource) {
            case 'draft':
                return this.serverTemplateExists
                    ? 'Editando borrador local. Existe plantilla en Salesforce; Guardar plantilla la actualiza.'
                    : 'Solo borrador en el navegador. Aún no hay plantilla en el servidor.';
            case 'server':
                return 'Configuración cargada desde la plantilla guardada en Salesforce.';
            case 'default':
            default:
                return 'Nueva configuración de diseño para este reporte.';
        }
    }
    get templateStatusBadgeClass() {
        const base = 'template-sync-badge';
        if (this.configLoadSource === 'server') return `${base} template-sync-badge--server`;
        if (this.configLoadSource === 'draft') return `${base} template-sync-badge--draft`;
        return `${base} template-sync-badge--default`;
    }
    get lastSavedTemplateLabel() {
        if (!this.lastTemplateSavedAt) return '';
        try {
            const d = new Date(this.lastTemplateSavedAt);
            return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return ''; }
    }

    /**
     * Calcula una firma rápida del workbookConfig para detectar cambios sin re-serializar todo.
     * Si recibe un config externo, lo usa; si no, usa this.workbookConfig.
     */
    _computeWorkbookSignature(cfgOverride) {
        try {
            const cfg = cfgOverride || this.workbookConfig;
            if (!cfg || !Array.isArray(cfg.sheets)) return '';
            const sheetsPart = cfg.sheets.map(s => {
                const cols = (s.columns || []).map(c => `${c.apiName || c.fieldName || ''}|${c.alias || ''}|${c.hidden ? 1 : 0}|${c.format || ''}`).join(',');
                const filters = (s.filters && s.filters.filterColumn) ? `${s.filters.filterColumn}=${s.filters.filterValue || ''}` : '';
                return `${s.id || ''}|${s.name || ''}|${s.type || ''}|${s.sourceReportId || ''}|${cols.length}|${filters}|${cols}`;
            }).join('~');
            return [
                cfg.theme && cfg.theme.font || '',
                (cfg.virtualColumns || []).length,
                cfg.sheets.length,
                sheetsPart.length,
                sheetsPart
            ].join('::');
        } catch (_e) {
            return '';
        }
    }

    /** True si la config en memoria difiere de la última versión guardada en servidor. */
    get hasUnsavedChanges() {
        if (!this.selectedReportId) return false;
        if (!this.workbookConfig || !this.workbookConfig.sheets || !this.workbookConfig.sheets.length) return false;
        try {
            const current = this._computeWorkbookSignature();
            if (!this._savedConfigSignature) return !!current;
            return current !== this._savedConfigSignature;
        } catch (_e) {
            return false;
        }
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
            ? 'Hay cambios en memoria que aún no se guardaron en Salesforce. Usa "Guardar plantilla" para persistirlos.'
            : 'La configuración en memoria coincide con la plantilla guardada en Salesforce.';
    }

    connectedCallback() {
        this.loadRecentReports();
        this.loadFavorites();
        this.loadUiModePreference();
        this.loadDensityPreference();
        this.loadDarkModePreference();
        this._boundGlobalKeydown = this.handleGlobalKeydown.bind(this);
        window.addEventListener('keydown', this._boundGlobalKeydown);
        /* F2: tick periódico para refrescar el "Guardado hace Xs". 15 s es
           buen compromiso: suficientemente reactivo sin gastar ciclos. */
        this._autosaveInterval = setInterval(() => { this._autosaveTick++; }, 15000);
    }

    renderedCallback() { 
        if (!this.excelJsLoaded && !this.excelJsLoading) {
            this.excelJsLoading = true;
            loadScript(this, EXCEL_JS)
                .then(() => { this.excelJsLoaded = true; })
                .catch(e => { console.error(e); this.showToast('Error', 'No se pudo cargar ExcelJS.', 'error'); })
                .finally(() => { this.excelJsLoading = false; });
        }
        if (!this.pdfJsLoaded && !this.pdfJsLoading) {
            this.pdfJsLoading = true;
            loadScript(this, JSPDF)
                .then(() => loadScript(this, JSPDF_AUTOTABLE))
                .then(() => { this.pdfJsLoaded = true; })
                .catch(e => { console.error(e); this.showToast('Error', 'No se pudo cargar jsPDF.', 'error'); })
                .finally(() => { this.pdfJsLoading = false; });
        }
        /* F5: Chart.js se carga la primera vez bajo demanda (cuando hay un chart
           definido o se abre el modal). Sirve para evitar cargar la librería en
           reportes donde no se usa. Tolerante a errores: si el resource no existe
           en la org, los gráficos quedan deshabilitados sin afectar al resto. */
        if (!this.chartjsLoaded && !this.chartjsLoading && this._chartjsShouldLoad()) {
            this.chartjsLoading = true;
            loadScript(this, CHARTJS + '/chart.umd.js')
                .then(() => { this.chartjsLoaded = true; this._renderAllChartsAfterLoad(); })
                .catch(_e => {
                    /* fallback: probar con el js en raíz por si el zip no tiene subcarpeta */
                    return loadScript(this, CHARTJS)
                        .then(() => { this.chartjsLoaded = true; this._renderAllChartsAfterLoad(); })
                        .catch(e2 => { console.warn('Chart.js no disponible:', e2); this.chartjsUnavailable = true; });
                })
                .finally(() => { this.chartjsLoading = false; });
        }
        /* Si ya está cargado, re-renderiza para reflejar cambios en datos/config. */
        if (this.chartjsLoaded) this._renderAllChartsAfterLoad();
    }
    _chartjsShouldLoad() {
        if (this.showChartModal) return true;
        if (!this.activeSheet || !Array.isArray(this.activeSheet.charts)) return false;
        return this.activeSheet.charts.length > 0;
    }

    @wire(getAvailableReports)
    wiredReports({ error, data }) { if (data) { this.reportOptions = data.map(r => ({ label: r.Name, value: r.Id })); this.isLoadingReports = false; } else if (error) { this.isLoadingReports = false; this.showToast('Error', 'No se pudieron cargar los reportes.', 'error'); } }

    get isActionDisabled() { return !this.selectedReportId || !this.hasActiveSheet || this.isFetchingData; }
    /* Guard para acciones que dependen de la variante elegida (PPT, guardado, etc.).
       Si el usuario aún no eligió variante, el currentVariantId es null y cualquier
       acción acabaría asociada a la "variante default implícita" — lo que en el
       reportePptBuilder se traduce en abrir un diseño que no es el que el usuario
       configuró. Mejor bloquear y forzar la elección desde el picker. */
    get isVariantRequired() { return !this.currentVariantId; }
    get isPptActionDisabled() { return this.isActionDisabled || this.isVariantRequired; }
    get pptActionTooltip() {
        if (!this.selectedReportId) return 'Selecciona un reporte para continuar';
        if (this.isFetchingData) return 'Cargando datos del reporte...';
        if (!this.hasActiveSheet) return 'No hay hoja activa para exportar';
        if (this.isVariantRequired) return 'Elige una variante del reporte antes de avanzar a PPT — el diseño PPT se asocia a cada variante';
        return 'Avanzar al constructor de PowerPoint';
    }
    get hasActiveSheet() { return !!this.activeSheet; }
    get isShowAllColumnsDisabled() { return !this.hasActiveSheet || !this.activeSheet.columns || this.activeSheet.columns.length === 0; }
    get activeSheet() { if (!this.workbookConfig || !this.workbookConfig.sheets || !this.activeSheetId) return null; return this.workbookConfig.sheets.find(s => s.id === this.activeSheetId); }
    get activeSheetTypeLabel() { if (!this.activeSheet) return ''; return this.activeSheet.type === 'summary' ? 'Hoja Resumen' : 'Tabla detalle'; }
    get visibleColumnsCount() {
        if (!this.activeSheet || !this.activeSheet.columns) return 0;
        return this.activeSheet.columns.filter(c => c.visible).length;
    }
    get visibleFieldCountLabel() {
        const total = (this.baseColumns && this.baseColumns.length) ? this.baseColumns.length : 0;
        const vis = this.visibleColumnsCount;
        return `${vis} / ${total} visibles`;
    }
    get invalidPivotCount() {
        if (!this.activeSheet || !this.activeSheet.subTables) return 0;
        return this.activeSheet.subTables.filter(sub => {
            if (!sub.groupByField) return true;
            if ((sub.operation === 'SUM' || sub.operation === 'AVG') && !sub.metricField) return true;
            return false;
        }).length;
    }
    get hasSheetConfigWarnings() {
        if (!this.activeSheet) return false;
        if (this.isTableSheet && this.visibleColumnsCount === 0) return true;
        if (this.isSummarySheet && this.invalidPivotCount > 0) return true;
        return false;
    }
    get sheetConfigWarningText() {
        if (!this.activeSheet) return '';
        if (this.isTableSheet && this.visibleColumnsCount === 0) return 'No hay columnas visibles. Activa al menos una columna para exportar.';
        if (this.isSummarySheet && this.invalidPivotCount > 0) return `Hay ${this.invalidPivotCount} tabla(s) Pivot incompleta(s). Completa "Agrupar por" y métrica cuando aplique.`;
        return '';
    }
    get sheetTypeOptions() { return [{ label: 'Tabla de detalle (filas)', value: 'detail' }, { label: 'Resumen con tablas pivot', value: 'summary' }]; }
    get alignmentOptions() { return [{ label: 'Izquierda', value: 'left' }, { label: 'Centro', value: 'center' }, { label: 'Derecha', value: 'right' }]; }
    get decoratedSheets() {
        const dragId = this.draggedSheetId;
        const overId = this.dragOverSheetId;
        const pos = this.dragOverSheetPosition;
        return (this.workbookConfig.sheets || []).map(s => {
            let wrapClass = 'tab-wrap';
            if (overId && s.id === overId && dragId && dragId !== overId) {
                wrapClass += pos === 'after' ? ' tab-wrap--drop-after' : ' tab-wrap--drop-before';
            }
            if (dragId && s.id === dragId) wrapClass += ' tab-wrap--dragging';
            return {
                ...s,
                tabClass: s.id === this.activeSheetId ? 'sheet-tab active' : 'sheet-tab',
                wrapClass
            };
        });
    }
    
    /* Orden del panel izquierdo. Usa column.order de la hoja activa para que el
       drag-reorder afecte también a la tabla central, al Excel y al PPT
       (mismas columnas con el mismo orden, ya que previewColumns y los
       buildDetailSheet ordenan por column.order). Las columnas que no estén
       todavía en activeSheet.columns (caso muy raro: virtuales globales no
       inyectadas en la hoja) se quedan al final preservando su orden natural. */
    get orderedBaseColumns() {
        if (!this.baseColumns || !this.baseColumns.length) return [];
        const sheetCols = (this.activeSheet && this.activeSheet.columns) ? this.activeSheet.columns : [];
        if (!sheetCols.length) return this.baseColumns;
        const orderMap = new Map();
        for (const c of sheetCols) orderMap.set(c.apiName, c.order);
        const MAX = Number.MAX_SAFE_INTEGER;
        const withIdx = this.baseColumns.map((c, i) => ({ c, i }));
        withIdx.sort((a, b) => {
            const oa = orderMap.has(a.c.apiName) ? orderMap.get(a.c.apiName) : MAX;
            const ob = orderMap.has(b.c.apiName) ? orderMap.get(b.c.apiName) : MAX;
            if (oa !== ob) return oa - ob;
            return a.i - b.i;
        });
        return withIdx.map(x => x.c);
    }
    get filteredAvailableColumns() { 
        if (!this.activeSheet || !this.activeSheet.columns) return []; const term = (this.fieldSearchTerm || '').toLowerCase(); 
        return this.orderedBaseColumns.filter(c => !term || c.label.toLowerCase().includes(term) || c.apiName.toLowerCase().includes(term)).map(c => { 
            const sc = this.activeSheet.columns.find(i => i.apiName === c.apiName); const vis = sc ? sc.visible : false; 
            return { ...c, visible: vis, iconName: vis ? 'utility:check' : 'utility:add', cardClass: vis ? 'field-item active' : 'field-item' }; 
        }); 
    }
    get filterOperatorOptions() {
        return FILTER_OPERATORS.map((op) => ({ label: op.label, value: op.value }));
    }
    get activeFiltersDecorated() {
        if (!this.activeSheet || !this.activeSheet.filters) return [];
        const raw = this.normalizeSheetFilters(this.activeSheet.filters).items;
        return raw.map((f, idx) => {
            const spec = FILTER_OPERATOR_MAP[resolveFilterOperator(f)] || FILTER_OPERATOR_MAP.eq;
            const needsValue = spec.needsValue;
            const isRange = spec.value === 'between';
            const isNumeric = spec.valueKind === 'number' || isRange;
            /* eq/neq usan combobox con valores existentes; el resto, input libre (texto/numero). */
            const useDropdown = spec.value === 'eq' || spec.value === 'neq';
            const logicLabel = (f.logic === 'OR') ? 'O' : 'Y';
            return {
                ...f,
                key: f.id,
                index: idx,
                showLogic: idx > 0,
                logicChipLabel: logicLabel,
                logicChipTitle: f.logic === 'OR'
                    ? 'Conector OR: cualquiera de las condiciones cumple. Click para cambiar a Y (AND).'
                    : 'Conector AND: deben cumplirse todas las condiciones. Click para cambiar a O (OR).',
                operatorLabel: spec.label,
                showValueInput: needsValue && !useDropdown && !isRange,
                showValueDropdown: needsValue && useDropdown,
                showValueRange: isRange,
                valueInputType: isNumeric ? 'number' : 'text',
                valueLabel: isRange ? 'Desde' : 'Valor',
                value2Label: 'Hasta',
                valueOptions: this.getFilterValueOptionsForColumn(f.filterColumn)
            };
        });
    }
    get activeFilterCount() {
        if (!this.activeSheet || !this.activeSheet.filters) return 0;
        const raw = this.normalizeSheetFilters(this.activeSheet.filters).items;
        return raw.filter((f) => isFilterUsable(f)).length;
    }
    get activeFilterSummary() {
        const n = this.activeFilterCount;
        if (!n) return 'Sin filtros activos.';
        return `${n} filtro(s) activo(s).`;
    }
    /* Lista visual de filtros activos para mostrar como "chips" en la
       pestaña Filtros del panel derecho. Cada chip muestra el nombre de la
       columna y la condición (igual a, distinto, contiene…) con el valor.
       El botón × elimina el filtro reutilizando removeSheetFilter. */
    get activeFilterChips() {
        if (!this.activeSheet || !this.activeSheet.filters) return [];
        const items = this.normalizeSheetFilters(this.activeSheet.filters).items || [];
        const cols = this.baseColumns || [];
        return items.filter(isFilterUsable).map((f) => {
            const colDef = cols.find(c => c.apiName === f.filterColumn);
            const colLabel = (colDef && colDef.label) ? colDef.label : f.filterColumn;
            const op = resolveFilterOperator(f);
            const spec = FILTER_OPERATOR_MAP[op] || FILTER_OPERATOR_MAP.eq;
            /* Símbolo corto para condición cuando aplica; si no, label completo. */
            const symbolMap = {
                eq: '=', neq: '≠', contains: '∋', notContains: '∌',
                startsWith: '↦', endsWith: '↤', gt: '>', gte: '≥',
                lt: '<', lte: '≤', between: '↔', empty: '∅', notEmpty: '≠ ∅'
            };
            const symbol = symbolMap[op] || spec.label;
            let valuePart = '';
            if (op === 'empty') valuePart = '';
            else if (op === 'notEmpty') valuePart = '';
            else if (op === 'between') valuePart = ` ${f.filterValue || '?'} – ${f.filterValue2 || '?'}`;
            else valuePart = ` ${f.filterValue}`;
            return {
                id: f.id,
                label: `${colLabel} ${symbol}${valuePart}`,
                title: `${colLabel} · ${spec.label}${valuePart ? ' ' + valuePart : ''}`
            };
        });
    }
    get hasActiveFilterChips() { return this.activeFilterChips.length > 0; }
    /* U7: línea-resumen visual del modal de filtros.
       Genera un array intercalado: [chip, conector, chip, conector, ...]
       a partir de los filtros usables. El conector usa la "logic" de cada
       filtro a partir del segundo (logic de items[i] indica con qué conector
       se enlaza con items[i-1]). */
    get activeFilterSummaryChips() {
        const chips = this.activeFilterChips;
        const items = this.activeSheet && this.activeSheet.filters
            ? this.normalizeSheetFilters(this.activeSheet.filters).items
            : [];
        const usableItems = items.filter(isFilterUsable);
        const out = [];
        chips.forEach((chip, i) => {
            if (i > 0) {
                const logic = (usableItems[i] && usableItems[i].logic) === 'OR' ? 'O' : 'Y';
                out.push({ id: `${chip.id}__conn`, isConnector: true, label: logic });
            }
            out.push({ ...chip, isConnector: false });
        });
        return out;
    }
    /* Alterna el conector lógico (AND ⇄ OR) de un filtro. Reusado en el modal
       como chip clickable entre filas. */
    handleSheetFilterLogicToggle(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        if (!fid) return;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = filters.items.map(f => f.id === fid ? { ...f, logic: (f.logic === 'OR' ? 'AND' : 'OR') } : f);
        this.updateActiveSheet({ filters: { ...filters, items } });
    }
    get selectedColumn() { return this.activeSheet ? this.activeSheet.columns.find(c => c.apiName === this.selectedColumnApiName) : null; }
    get previewColumns() {
        const visible = (this.activeSheet ? this.activeSheet.columns : []).filter(c => c.visible).sort((a,b) => a.order - b.order);
        const sortBy = this.activeSheet && this.activeSheet.settings ? this.activeSheet.settings.sortBy : '';
        const sortDir = this.activeSheet && this.activeSheet.settings ? this.activeSheet.settings.sortDirection : 'ASC';
        const frozen = this.frozenColumnsCount;
        /* V3: set de apiNames con filtro usable, para resaltar el botón ▾. */
        const filteredCols = new Set(
            this.activeSheet && this.activeSheet.filters
                ? (this.normalizeSheetFilters(this.activeSheet.filters).items || [])
                    .filter(f => isFilterUsable(f))
                    .map(f => f.filterColumn || f.column)
                : []
        );
        return visible.map((c, index) => {
            const isSorted = !!sortBy && sortBy === c.apiName;
            const dirAsc = (sortDir || 'ASC').toUpperCase() !== 'DESC';
            const sortIndicator = isSorted ? (dirAsc ? '▲' : '▼') : '↕';
            const sortBtnTitle = isSorted
                ? (dirAsc ? `Ordenado ascendente. Click: descendente. Doble click: quitar orden por «${c.alias || c.label}».`
                          : `Ordenado descendente. Click: quitar orden.`)
                : `Ordenar por «${c.alias || c.label}» (ascendente).`;
            const isFrozen = frozen > 0 && index < frozen;
            const frozenStyle = isFrozen ? this._buildFrozenStickyStyle(visible, index) : '';
            const hasHeaderFilter = filteredCols.has(c.apiName);
            let thClass = c.apiName === this.selectedColumnApiName ? 'preview-th selected' : 'preview-th';
            if (isSorted) thClass += ' preview-th--sorted';
            if (isFrozen) thClass += ' preview-th--frozen';
            if (hasHeaderFilter) thClass += ' preview-th--filtered';
            return {
                ...c,
                isFirst: index === 0,
                headerStyle: this._mergeStyles(this.buildHeaderStyle(c, index, visible.length), frozenStyle),
                dataStyle: this.buildDataStyle(c, index, visible.length),
                thClass,
                isSorted,
                sortIndicator,
                sortBtnTitle,
                sortBtnClass: isSorted ? 'th-sort-btn th-sort-btn--active' : 'th-sort-btn',
                isFrozen,
                frozenStyle,
                hasHeaderFilter,
                filterBtnClass: hasHeaderFilter ? 'th-filter-btn th-filter-btn--active' : 'th-filter-btn',
                filterBtnTitle: hasHeaderFilter
                    ? `Filtrando «${c.alias || c.label}». Click para editar valores.`
                    : `Filtrar valores de «${c.alias || c.label}».`
            };
        });
    }
    _mergeStyles(a, b) {
        if (!a) return b || '';
        if (!b) return a;
        const aa = a.endsWith(';') ? a : a + ';';
        return aa + b;
    }
    /* F3: cantidad de columnas a congelar (sticky left) en el preview y en Excel.
       Se persiste en activeSheet.settings.frozenColumns (0..3). */
    get frozenColumnsCount() {
        if (!this.activeSheet || !this.activeSheet.settings) return 0;
        const n = parseInt(this.activeSheet.settings.frozenColumns, 10);
        if (isNaN(n) || n < 0) return 0;
        return Math.min(n, 3);
    }
    get frozenColumnsOptions() {
        return [
            { label: 'Ninguna', value: '0' },
            { label: '1 columna', value: '1' },
            { label: '2 columnas', value: '2' },
            { label: '3 columnas', value: '3' }
        ];
    }
    get frozenColumnsValue() { return String(this.frozenColumnsCount); }
    handleFrozenColumnsChange(event) {
        if (!this.activeSheet) return;
        const v = parseInt(event.detail.value, 10) || 0;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, frozenColumns: Math.min(Math.max(v, 0), 3) } });
    }
    /* Calcula el desplazamiento horizontal acumulado para la columna `index`
       (suma de los ancho de las columnas previas). Asume que todas las columnas
       previas son congeladas (son las primeras N). */
    _buildFrozenStickyStyle(visibleCols, index) {
        let left = 0;
        for (let i = 0; i < index; i++) {
            const w = (visibleCols[i] && visibleCols[i].width) ? parseInt(visibleCols[i].width, 10) : 120;
            left += isNaN(w) ? 120 : w;
        }
        return `left:${left}px; background-color: var(--pandora-surface, #fff);`;
    }
    /* F5: Gráficos con Chart.js.
       Modelo: activeSheet.charts[] con { id, type, title, groupByField, valueField,
       operation, sortBy, sortDirection, limit }. Render en <canvas> dentro de
       chart-cards bajo la tabla. Tolerante a Chart.js ausente. */
    @track chartjsLoaded = false;
    @track chartjsLoading = false;
    @track chartjsUnavailable = false;
    @track showChartModal = false;
    @track editingChartDraft = null;
    _chartInstances = new Map();
    get hasActiveSheetCharts() {
        return !!(this.activeSheet && Array.isArray(this.activeSheet.charts) && this.activeSheet.charts.length);
    }
    get activeSheetCharts() {
        if (!this.hasActiveSheetCharts) return [];
        return this.activeSheet.charts.map(c => ({
            ...c,
            canvasId: 'chart_canvas_' + c.id,
            typeLabel: this._chartTypeLabel(c.type)
        }));
    }
    get chartTypeOptions() {
        return [
            { label: 'Barras (vertical)',   value: 'bar' },
            { label: 'Barras horizontales', value: 'horizontalBar' },
            { label: 'Líneas',              value: 'line' },
            { label: 'Pastel (Pie)',        value: 'pie' },
            { label: 'Dona (Doughnut)',     value: 'doughnut' }
        ];
    }
    get chartOperationOptions() {
        return [
            { label: 'Conteo (cantidad de filas)', value: 'COUNT' },
            { label: 'Suma',                       value: 'SUM' },
            { label: 'Promedio',                   value: 'AVG' },
            { label: 'Mínimo',                     value: 'MIN' },
            { label: 'Máximo',                     value: 'MAX' }
        ];
    }
    get chartLimitOptions() {
        return [
            { label: 'Top 5',  value: '5' },
            { label: 'Top 10', value: '10' },
            { label: 'Top 15', value: '15' },
            { label: 'Top 20', value: '20' },
            { label: 'Sin límite', value: '0' }
        ];
    }
    _chartTypeLabel(t) {
        const found = this.chartTypeOptions.find(o => o.value === t);
        return found ? found.label : t;
    }
    openAddChartModal() {
        this.editingChartDraft = {
            id: '',
            type: 'bar',
            title: '',
            groupByField: '',
            valueField: '',
            operation: 'COUNT',
            sortBy: 'VALUE',
            sortDirection: 'DESC',
            limit: '10'
        };
        this.showChartModal = true;
    }
    openEditChartModal(event) {
        const cid = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
        if (!cid || !this.activeSheet) return;
        const c = (this.activeSheet.charts || []).find(x => x.id === cid);
        if (!c) return;
        this.editingChartDraft = { ...c };
        this.showChartModal = true;
    }
    closeChartModal() {
        this.showChartModal = false;
        this.editingChartDraft = null;
    }
    handleChartDraftChange(event) {
        const field = event.target.dataset.field;
        const value = event.detail.value !== undefined ? event.detail.value : event.target.value;
        if (!this.editingChartDraft) return;
        this.editingChartDraft = { ...this.editingChartDraft, [field]: value };
    }
    saveChartFromModal() {
        if (!this.activeSheet || !this.editingChartDraft) return;
        const d = this.editingChartDraft;
        if (!d.groupByField) {
            this.showToast('Falta campo', 'Selecciona la columna para agrupar (categorías).', 'warning');
            return;
        }
        if (d.operation !== 'COUNT' && !d.valueField) {
            this.showToast('Falta campo', 'Selecciona la columna numérica para la operación.', 'warning');
            return;
        }
        const existing = (this.activeSheet.charts || []);
        let newCharts;
        if (d.id) {
            newCharts = existing.map(c => c.id === d.id ? { ...d } : c);
        } else {
            const newChart = { ...d, id: 'chart_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) };
            newCharts = [...existing, newChart];
        }
        this.updateActiveSheet({ charts: newCharts });
        this.closeChartModal();
    }
    deleteChart(event) {
        const cid = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
        if (!cid || !this.activeSheet) return;
        const list = (this.activeSheet.charts || []).filter(c => c.id !== cid);
        this.updateActiveSheet({ charts: list });
        if (this._chartInstances.has(cid)) {
            try { this._chartInstances.get(cid).destroy(); } catch (_e) { /* no-op */ }
            this._chartInstances.delete(cid);
        }
    }
    /* Calcula data buckets para un gráfico a partir de filas del reporte y
       config { groupByField, valueField, operation, sortBy, sortDirection, limit }. */
    _computeChartDataset(chart) {
        const parsed = this.getParsedReportData();
        if (!parsed || !this.activeSheet) return null;
        const rows = getRowsForSheet(this.activeSheet, parsed);
        const detailCols = (parsed.reportMetadata && parsed.reportMetadata.detailColumns) || [];
        const groupIdx = detailCols.indexOf(chart.groupByField);
        const valueIdx = detailCols.indexOf(chart.valueField);
        if (groupIdx === -1) return null;
        const buckets = new Map();
        const toNumber = (v) => {
            const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-,]/g, '').replace(',', '.'));
            return isNaN(n) ? 0 : n;
        };
        rows.forEach(r => {
            const labelRaw = r.dataCells && r.dataCells[groupIdx] ? r.dataCells[groupIdx].label : '';
            const label = labelRaw == null || labelRaw === '' ? '(vacío)' : String(labelRaw);
            const valRaw = valueIdx >= 0 && r.dataCells && r.dataCells[valueIdx]
                ? (r.dataCells[valueIdx].value != null ? r.dataCells[valueIdx].value : r.dataCells[valueIdx].label)
                : 0;
            const val = toNumber(valRaw);
            if (!buckets.has(label)) buckets.set(label, { sum: 0, count: 0, min: Infinity, max: -Infinity, values: [] });
            const b = buckets.get(label);
            b.count += 1;
            b.sum += val;
            if (val < b.min) b.min = val;
            if (val > b.max) b.max = val;
            b.values.push(val);
        });
        const op = (chart.operation || 'COUNT').toUpperCase();
        let entries = Array.from(buckets.entries()).map(([k, b]) => {
            let v;
            switch (op) {
                case 'SUM': v = b.sum; break;
                case 'AVG': v = b.count ? b.sum / b.count : 0; break;
                case 'MIN': v = b.min === Infinity ? 0 : b.min; break;
                case 'MAX': v = b.max === -Infinity ? 0 : b.max; break;
                default:    v = b.count;
            }
            return { label: k, value: v };
        });
        const dir = (chart.sortDirection || 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
        const sortBy = chart.sortBy || 'VALUE';
        entries.sort((a, b) => {
            if (sortBy === 'LABEL') return dir * String(a.label).localeCompare(String(b.label));
            return dir * (a.value - b.value);
        });
        const limit = parseInt(chart.limit || '0', 10);
        if (limit > 0 && entries.length > limit) entries = entries.slice(0, limit);
        return entries;
    }
    /* Firma corta para detectar cambios en el chart o sus datos sin re-render
       constante. Si la firma no cambió, se reutiliza el chart existente. */
    _chartSignature(c) {
        return JSON.stringify({
            t: c.type, ti: c.title, g: c.groupByField, v: c.valueField, op: c.operation,
            sb: c.sortBy, sd: c.sortDirection, l: c.limit,
            d: this.reportDataJson ? this.reportDataJson.length : 0,
            f: this.activeSheet && this.activeSheet.filters ? JSON.stringify(this.activeSheet.filters) : ''
        });
    }
    _renderAllChartsAfterLoad() {
        if (!this.chartjsLoaded || !window.Chart) return;
        if (!this.hasActiveSheetCharts) return;
        if (!this._chartSignatures) this._chartSignatures = new Map();
        this.activeSheetCharts.forEach(c => {
            const sig = this._chartSignature(c);
            const prev = this._chartSignatures.get(c.id);
            if (prev === sig && this._chartInstances.has(c.id)) return;
            this._renderSingleChart(c);
            this._chartSignatures.set(c.id, sig);
        });
    }
    _renderSingleChart(chart) {
        try {
            const canvas = this.template.querySelector(`canvas[data-chart-id="${chart.id}"]`);
            if (!canvas) return;
            const ds = this._computeChartDataset(chart);
            if (!ds) return;
            const labels = ds.map(d => d.label);
            const values = ds.map(d => d.value);
            const isHoriz = chart.type === 'horizontalBar';
            const chartType = isHoriz ? 'bar' : chart.type;
            const palette = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#06B6D4','#F472B6','#84CC16','#6366F1','#F97316','#14B8A6','#EAB308','#A855F7','#22C55E','#0EA5E9','#DC2626','#7C3AED','#DB2777','#65A30D','#0891B2'];
            const bgColors = labels.map((_, i) => palette[i % palette.length]);
            if (this._chartInstances.has(chart.id)) {
                try { this._chartInstances.get(chart.id).destroy(); } catch (_e) { /* no-op */ }
                this._chartInstances.delete(chart.id);
            }
            const cfg = {
                type: chartType,
                data: {
                    labels,
                    datasets: [{
                        label: chart.title || chart.valueField || 'Valor',
                        data: values,
                        backgroundColor: (chartType === 'line') ? 'rgba(59,130,246,0.2)' : bgColors,
                        borderColor: (chartType === 'line') ? '#3B82F6' : '#ffffff',
                        borderWidth: (chartType === 'pie' || chartType === 'doughnut') ? 2 : 1,
                        tension: 0.3,
                        fill: chartType === 'line'
                    }]
                },
                options: {
                    indexAxis: isHoriz ? 'y' : 'x',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: (chartType === 'pie' || chartType === 'doughnut'), position: 'bottom' },
                        title:  { display: !!chart.title, text: chart.title || '' }
                    },
                    scales: (chartType === 'pie' || chartType === 'doughnut') ? {} : {
                        x: { ticks: { autoSkip: true, maxRotation: 45 } },
                        y: { beginAtZero: true }
                    }
                }
            };
            const inst = new window.Chart(canvas.getContext('2d'), cfg);
            this._chartInstances.set(chart.id, inst);
        } catch (e) {
            console.warn('Error renderizando chart', chart.id, e);
        }
    }
    /* F4: Vistas guardadas — snapshot por hoja del estado de columnas + filtros + orden.
       Se almacena en workbookConfig.savedViews[] (persistido junto con el resto).
       Cada vista tiene { id, name, sheetId, savedAt, snapshot }.
       K2: feature flag para ocultar la UI sin perder datos ni handlers. Las variantes
       cubren este caso de uso (y mejor: con storage propio en SF, no embebido en el JSON). */
    get featureSavedViewsEnabled() { return false; }
    @track isSavedViewsMenuOpen = false;
    @track savedViewsMenuStyle = '';
    @track isSavingViewName = false;
    @track savingViewNameInput = '';
    get savedViewsAll() {
        return (this.workbookConfig && Array.isArray(this.workbookConfig.savedViews)) ? this.workbookConfig.savedViews : [];
    }
    get savedViewsForActiveSheet() {
        if (!this.activeSheet) return [];
        return this.savedViewsAll.filter(v => v.sheetId === this.activeSheet.id);
    }
    get savedViewsDecorated() {
        const fmt = (ts) => {
            if (!ts) return '';
            try {
                const d = new Date(ts);
                return d.toLocaleDateString() + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            } catch (_e) { return ''; }
        };
        return this.savedViewsForActiveSheet.map(v => ({ ...v, savedAtLabel: fmt(v.savedAt) }));
    }
    get hasSavedViews() { return this.savedViewsForActiveSheet.length > 0; }
    get savedViewsCountLabel() {
        const n = this.savedViewsForActiveSheet.length;
        if (!n) return '';
        return `${n}`;
    }
    get hasSavedViewsBadge() { return this.savedViewsForActiveSheet.length > 0; }
    toggleSavedViewsMenu(event) {
        if (this.isSavedViewsMenuOpen) {
            this.closeSavedViewsMenu();
            return;
        }
        /* Para calcular la posición del menú flotante, preferimos el wrap
           contenedor (no el lightning-button-icon, cuyo rect en shadow DOM puede
           no ser fiable). Si no lo encontramos, caemos a una esquina sensata. */
        const wrap = this.template.querySelector('.saved-views-trigger-wrap');
        const rect = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
        if (rect) {
            this.savedViewsMenuStyle = `top: ${rect.bottom + 6}px; right: ${Math.max(8, window.innerWidth - rect.right)}px;`;
        } else {
            this.savedViewsMenuStyle = 'top: 90px; right: 24px;';
        }
        this.isSavedViewsMenuOpen = true;
        this.isSavingViewName = false;
        this.savingViewNameInput = '';
        /* Defer el listener: si lo registramos sincrónicamente, el mismo click
           que abrió el menú llega a document y lo cierra inmediatamente. Con
           setTimeout(0) lo registramos para los próximos clicks. */
        setTimeout(() => {
            if (!this._boundSavedViewsDocClick && this.isSavedViewsMenuOpen) {
                this._boundSavedViewsDocClick = this.handleSavedViewsDocClick.bind(this);
                document.addEventListener('click', this._boundSavedViewsDocClick, false);
            }
        }, 0);
    }
    closeSavedViewsMenu() {
        this.isSavedViewsMenuOpen = false;
        this.isSavingViewName = false;
        this.savingViewNameInput = '';
        if (this._boundSavedViewsDocClick) {
            document.removeEventListener('click', this._boundSavedViewsDocClick, false);
            this._boundSavedViewsDocClick = null;
        }
    }
    /* Stop propagation defensivo: clicks DENTRO del menú flotante o del trigger NO
       deben llegar al document, así no autocierran el menú. */
    stopSavedViewsPropagation(ev) { if (ev) ev.stopPropagation(); }
    handleSavedViewsDocClick(ev) {
        /* Detectar si el click ocurrió dentro del menú o del trigger.
           Para sortear el retargeting del shadow DOM cuando el click llega a
           document, comparamos directamente los nodos en composedPath() con
           los elementos del template (path.includes covers shadow-piercing). */
        const menuEl    = this.template.querySelector('.saved-views-menu');
        const triggerEl = this.template.querySelector('.saved-views-trigger-wrap');
        const path = (ev && typeof ev.composedPath === 'function') ? ev.composedPath() : [];
        if (menuEl && path.indexOf(menuEl) >= 0) return;
        if (triggerEl && path.indexOf(triggerEl) >= 0) return;
        /* Fallback por clase (synthetic shadow DOM puede ocultar nodos del path). */
        const insideByClass = path.some(el => el && el.classList && el.classList.contains &&
            (el.classList.contains('saved-views-menu') ||
             el.classList.contains('saved-views-trigger') ||
             el.classList.contains('saved-views-trigger-wrap')));
        if (insideByClass) return;
        this.closeSavedViewsMenu();
    }
    startSaveCurrentView() {
        this.isSavingViewName = true;
        this.savingViewNameInput = '';
    }
    handleSavedViewNameInput(event) { this.savingViewNameInput = event.target.value || ''; }
    handleSavedViewNameKeydown(event) {
        if (event.key === 'Enter') { event.preventDefault(); this.confirmSaveCurrentView(); }
        else if (event.key === 'Escape') { event.preventDefault(); this.isSavingViewName = false; this.savingViewNameInput = ''; }
    }
    confirmSaveCurrentView() {
        if (!this.activeSheet) return;
        const name = (this.savingViewNameInput || '').trim();
        if (!name) return;
        const snapshot = this._buildSheetSnapshot(this.activeSheet);
        const view = {
            id: 'view_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name: name.slice(0, 60),
            sheetId: this.activeSheet.id,
            sheetName: this.activeSheet.name,
            savedAt: Date.now(),
            snapshot
        };
        const list = this.savedViewsAll.slice();
        list.push(view);
        this.workbookConfig = { ...this.workbookConfig, savedViews: list };
        this.saveDraftToSession();
        this.isSavingViewName = false;
        this.savingViewNameInput = '';
        this.showToast('Vista guardada', `«${view.name}» quedó disponible en este reporte.`, 'success');
    }
    applySavedView(event) {
        event.stopPropagation();
        if (!this.activeSheet) return;
        const vid = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
        if (!vid) return;
        const v = this.savedViewsAll.find(x => x.id === vid);
        if (!v || !v.snapshot) return;
        this._applySheetSnapshot(this.activeSheet, v.snapshot);
        this.closeSavedViewsMenu();
        this.showToast('Vista aplicada', `Se restauró «${v.name}».`, 'success');
    }
    deleteSavedView(event) {
        event.stopPropagation();
        const vid = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
        if (!vid) return;
        const list = this.savedViewsAll.filter(v => v.id !== vid);
        this.workbookConfig = { ...this.workbookConfig, savedViews: list };
        this.saveDraftToSession();
    }
    _buildSheetSnapshot(sheet) {
        return {
            version: 1,
            columns: (sheet.columns || []).map(c => ({
                apiName: c.apiName,
                visible: !!c.visible,
                order: c.order,
                width: c.width,
                alias: c.alias,
                format: c.format,
                dateFormat: c.dateFormat,
                alignment: c.alignment,
                headerColor: c.headerColor,
                headerTextColor: c.headerTextColor,
                dataColor: c.dataColor,
                textColor: c.textColor
            })),
            filters: sheet.filters ? JSON.parse(JSON.stringify(sheet.filters)) : null,
            settings: {
                sortBy: sheet.settings && sheet.settings.sortBy,
                sortDirection: sheet.settings && sheet.settings.sortDirection,
                frozenColumns: sheet.settings && sheet.settings.frozenColumns,
                showTotals: !!(sheet.settings && sheet.settings.showTotals),
                showRowCount: !!(sheet.settings && sheet.settings.showRowCount)
            }
        };
    }
    _applySheetSnapshot(sheet, snap) {
        if (!snap) return;
        const byApi = new Map();
        (snap.columns || []).forEach(c => byApi.set(c.apiName, c));
        const newCols = (sheet.columns || []).map(c => {
            const s = byApi.get(c.apiName);
            if (!s) return c;
            return {
                ...c,
                visible: s.visible,
                order: s.order != null ? s.order : c.order,
                width: s.width != null ? s.width : c.width,
                alias: s.alias != null ? s.alias : c.alias,
                format: s.format || c.format,
                dateFormat: s.dateFormat || c.dateFormat,
                alignment: s.alignment || c.alignment,
                headerColor: s.headerColor != null ? s.headerColor : c.headerColor,
                headerTextColor: s.headerTextColor != null ? s.headerTextColor : c.headerTextColor,
                dataColor: s.dataColor != null ? s.dataColor : c.dataColor,
                textColor: s.textColor != null ? s.textColor : c.textColor
            };
        });
        const mergedSettings = { ...sheet.settings, ...(snap.settings || {}) };
        const mergedFilters = snap.filters ? snap.filters : sheet.filters;
        this.updateActiveSheet({ columns: newCols, settings: mergedSettings, filters: mergedFilters });
    }
    /* Click en la cabecera de columna: cicla orden ASC → DESC → sin orden.
       Usa stopPropagation para no disparar selectColumnFromEvent. */
    handleHeaderSort(event) {
        event.stopPropagation();
        if (!this.activeSheet || !this.activeSheet.settings) return;
        const apiName = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.apiName;
        if (!apiName) return;
        const currentBy = this.activeSheet.settings.sortBy || '';
        const currentDir = (this.activeSheet.settings.sortDirection || 'ASC').toUpperCase();
        let nextBy = apiName;
        let nextDir = 'ASC';
        if (currentBy === apiName) {
            if (currentDir === 'ASC') nextDir = 'DESC';
            else { nextBy = ''; nextDir = 'ASC'; }
        }
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, sortBy: nextBy, sortDirection: nextDir } });
    }
    get hasPreviewColumns() { return this.previewColumns.length > 0; }

    /** Vista previa del lienzo: detalle con columnas o resumen con pivots listos */
    get excelPreviewVisible() {
        if (!this.hasActiveSheet || !this.reportDataJson) return false;
        if (this.isTableSheet && this.hasPreviewColumns) return true;
        return !!(this.isSummarySheet && this.subTablePreviews && this.subTablePreviews.length > 0);
    }
    get isTableSheet() { return this.activeSheet && this.activeSheet.type === 'detail'; }
    get isSummarySheet() { return this.activeSheet && this.activeSheet.type === 'summary'; }

    /**
     * Devuelve el JSON del reporte ya parseado, cacheado por referencia de string.
     * Evita recalcular JSON.parse en cada render de getters (previewRows, subTablePreviews, etc.).
     * El cache se invalida automáticamente cuando reportDataJson cambia (cambio de reporte o reload).
     */
    getParsedReportData() {
        const raw = this.reportDataJson;
        if (!raw) return null;
        if (this._cachedParsedReportKey === raw && this._cachedParsedReportData) {
            return this._cachedParsedReportData;
        }
        try {
            const parsed = JSON.parse(raw);
            this._cachedParsedReportData = parsed;
            this._cachedParsedReportKey = raw;
            return parsed;
        } catch (e) {
            console.error('No se pudo parsear reportDataJson', e);
            return null;
        }
    }
    /* U1: con el rediseño UX las "herramientas avanzadas" pasan a estar siempre activas.
       Mantenemos el getter por compatibilidad con plantillas/getters existentes pero
       siempre devuelve true (sin gate). El toggle de la tarjeta "Experiencia libro
       multi-hoja" se eliminó del panel. */
    get isAdvancedMode() { return true; }
    get densityOptions() {
        return [
            { label: 'Cómodo · más espacio', value: 'comfortable' },
            { label: 'Compacto · más datos visibles', value: 'compact' }
        ];
    }
    get layoutPresetOptions() {
        return [
            { label: 'Todo visible + orden del reporte Salesforce', value: 'full_report_order' },
            { label: 'Solo 8 columnas (según orden actual)', value: 'focus_eight' },
            { label: 'Resetear anchos a 120 px', value: 'width_standard' }
        ];
    }
    get isLayoutPresetDisabled() { return !this.hasActiveSheet || this.isFetchingData; }
    get showDiscardDraftButton() {
        return !!(this.selectedReportId && this.serverTemplateExists && this.configLoadSource === 'draft' && !this.isFetchingData);
    }

    openStudioSettingsModal() { this.showStudioSettingsModal = true; }
    closeStudioSettingsModal() { this.showStudioSettingsModal = false; }
    openFiltersModal() { this.showFiltersModal = true; }
    closeFiltersModal() { this.showFiltersModal = false; }

    /* ─────────────────────────────────────────────────────────────────
       V3: AutoFiltro tipo Excel en cabecera de columna.
       Click en el botón ▾ de un <th> abre un dropdown con la lista de
       valores únicos (con checkbox + search). Al aplicar se crea/actualiza
       un filtro `in` en activeSheet.filters.items. Si selecciona todos,
       se elimina el filtro. Soporta búsqueda de valores y "Seleccionar
       todo".
       ───────────────────────────────────────────────────────────────── */
    @track headerFilterMenu = { visible: false, apiName: '', label: '', search: '', pos: 'top:0;left:0;' };
    @track headerFilterValues = []; /* [{ value, label, selected }] */

    /* Texto de la celda para un row dado (intenta label, luego value). */
    _cellTextOf(cell) {
        if (cell === null || cell === undefined) return '';
        if (typeof cell === 'object') {
            if (cell.label !== undefined && cell.label !== null && cell.label !== '') return String(cell.label);
            if (cell.value !== undefined && cell.value !== null) return String(cell.value);
            return '';
        }
        return String(cell);
    }
    /* Valores únicos de una columna sobre las filas del reporte,
       IGNORANDO el filtro de esa misma columna para que el usuario
       pueda reincorporar valores ocultos por el filtro actual. */
    _getHeaderFilterUniqueValues(apiName) {
        if (!this.activeSheet) return [];
        const parsed = this.getParsedReportData();
        if (!parsed) return [];
        const norm   = this.normalizeSheetFilters(this.activeSheet.filters);
        const sheetClone = {
            ...this.activeSheet,
            filters: { ...norm, items: (norm.items || []).filter(f => (f.filterColumn || f.column) !== apiName) }
        };
        const rows = getRowsForSheet(sheetClone, parsed);
        const counts = new Map();
        for (const row of rows) {
            const txt = this._cellTextOf(row && row[apiName]).trim();
            counts.set(txt, (counts.get(txt) || 0) + 1);
        }
        const out = [];
        counts.forEach((count, label) => {
            out.push({ value: label, label: label === '' ? '(vacío)' : label, count, selected: true });
        });
        out.sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
        return out;
    }
    /* Filtro 'in' actual sobre esa columna (si existe), para marcar checkboxes. */
    _getActiveInFilterValues(apiName) {
        if (!this.activeSheet || !this.activeSheet.filters) return null;
        const items = this.normalizeSheetFilters(this.activeSheet.filters).items || [];
        const f = items.find(x => (x.filterColumn || x.column) === apiName && resolveFilterOperator(x) === 'in');
        if (!f) return null;
        const v = f.filterValue !== undefined ? f.filterValue : f.value;
        const arr = Array.isArray(v) ? v : (v == null ? [] : String(v).split('|'));
        return arr.map(x => String(x).trim());
    }
    openHeaderFilter(event) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        const btn = event && event.currentTarget;
        const apiName = btn && btn.dataset ? btn.dataset.apiName : null;
        if (!apiName) return;
        /* Cierra si reabre la misma columna. */
        if (this.headerFilterMenu.visible && this.headerFilterMenu.apiName === apiName) {
            this.closeHeaderFilter();
            return;
        }
        const colDef  = (this.baseColumns || []).find(c => c.apiName === apiName);
        const label   = colDef ? colDef.label : apiName;
        const values  = this._getHeaderFilterUniqueValues(apiName);
        const current = this._getActiveInFilterValues(apiName);
        if (current && current.length) {
            const selSet = new Set(current.map(s => s.toLowerCase()));
            for (const v of values) v.selected = selSet.has(String(v.value).toLowerCase());
        }
        /* Posicionamos el menú flotante bajo el botón ▾. */
        let pos = 'top:120px;left:240px;';
        if (btn && btn.getBoundingClientRect) {
            const r = btn.getBoundingClientRect();
            const top  = Math.round(r.bottom + 4);
            const left = Math.max(8, Math.round(r.left - 220));
            pos = `top:${top}px;left:${left}px;`;
        }
        this.headerFilterValues = values;
        this.headerFilterMenu = { visible: true, apiName, label, search: '', pos };
        if (!this._boundHeaderFilterDocClick) {
            this._boundHeaderFilterDocClick = this.handleHeaderFilterDocClick.bind(this);
            setTimeout(() => {
                if (this.headerFilterMenu.visible && !this._headerFilterListenerActive) {
                    document.addEventListener('click', this._boundHeaderFilterDocClick, false);
                    this._headerFilterListenerActive = true;
                }
            }, 0);
        }
    }
    stopHeaderFilterPropagation(ev) { if (ev) ev.stopPropagation(); }
    handleHeaderFilterDocClick(ev) {
        const menuEl = this.template.querySelector('.header-filter-menu');
        const path = (ev && typeof ev.composedPath === 'function') ? ev.composedPath() : [];
        if (menuEl && path.indexOf(menuEl) >= 0) return;
        /* Si el click es sobre otro botón th-filter-btn dejamos que él gestione. */
        const onFilterBtn = path.some(el => el && el.classList && el.classList.contains && el.classList.contains('th-filter-btn'));
        if (onFilterBtn) return;
        this.closeHeaderFilter();
    }
    closeHeaderFilter() {
        this.headerFilterMenu = { visible: false, apiName: '', label: '', search: '', pos: 'top:0;left:0;' };
        this.headerFilterValues = [];
        if (this._boundHeaderFilterDocClick && this._headerFilterListenerActive) {
            document.removeEventListener('click', this._boundHeaderFilterDocClick, false);
            this._headerFilterListenerActive = false;
        }
    }
    handleHeaderFilterSearchInput(event) {
        const term = (event.target.value || '').toLowerCase();
        this.headerFilterMenu = { ...this.headerFilterMenu, search: term };
    }
    toggleHeaderFilterValue(event) {
        const idx = Number(event.currentTarget.dataset.idx);
        if (Number.isNaN(idx)) return;
        const list = this.headerFilterValues.slice();
        list[idx] = { ...list[idx], selected: !list[idx].selected };
        this.headerFilterValues = list;
    }
    toggleHeaderFilterAll() {
        const all = this.headerFilterAllSelected;
        this.headerFilterValues = this.headerFilterValues.map(v => ({ ...v, selected: !all }));
    }
    clearHeaderFilter() {
        if (!this.activeSheet) return;
        const apiName = this.headerFilterMenu.apiName;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters);
        const next = { ...filters, items: (filters.items || []).filter(f => (f.filterColumn || f.column) !== apiName) };
        this.updateActiveSheet({ filters: next });
        this.closeHeaderFilter();
    }
    applyHeaderFilter() {
        if (!this.activeSheet) return;
        const apiName = this.headerFilterMenu.apiName;
        const total   = this.headerFilterValues.length;
        const sel     = this.headerFilterValues.filter(v => v.selected);
        const filters = this.normalizeSheetFilters(this.activeSheet.filters);
        const items   = (filters.items || []).filter(f => (f.filterColumn || f.column) !== apiName);
        if (sel.length === 0) {
            /* nada seleccionado → no aplicamos nada (equivalente a quitar el filtro). */
            this.updateActiveSheet({ filters: { ...filters, items } });
            this.closeHeaderFilter();
            return;
        }
        if (sel.length < total) {
            const id = 'flt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            const arr = sel.map(v => v.value);
            items.push({
                id,
                filterColumn: apiName,
                operator: 'in',
                filterValue: arr,
                filterValue2: '',
                logic: items.length > 0 ? 'AND' : 'AND'
            });
        }
        /* Si seleccionó todos, no añadimos filtro (equivale a quitarlo). */
        this.updateActiveSheet({ filters: { ...filters, items } });
        this.closeHeaderFilter();
    }
    /* Getters para la UI del menú. */
    get headerFilterFilteredValues() {
        const term = (this.headerFilterMenu.search || '').toLowerCase();
        if (!term) return this.headerFilterValues.map((v, i) => ({ ...v, idx: i, checkboxClass: v.selected ? 'hf-check hf-check--on' : 'hf-check' }));
        return this.headerFilterValues
            .map((v, i) => ({ ...v, idx: i, checkboxClass: v.selected ? 'hf-check hf-check--on' : 'hf-check' }))
            .filter(v => v.label.toLowerCase().includes(term));
    }
    get headerFilterAllSelected() { return this.headerFilterValues.length > 0 && this.headerFilterValues.every(v => v.selected); }
    get headerFilterAllSelectedClass() { return this.headerFilterAllSelected ? 'hf-check hf-check--on' : 'hf-check'; }
    get headerFilterAllLabel() { return this.headerFilterAllSelected ? 'Deseleccionar todo' : 'Seleccionar todo'; }
    get headerFilterApplyDisabled() { return this.headerFilterValues.length === 0; }
    get headerFilterSelectedCount() { return this.headerFilterValues.filter(v => v.selected).length; }
    get headerFilterCountLabel() {
        const n = this.headerFilterSelectedCount;
        const t = this.headerFilterValues.length;
        if (t === 0) return '';
        if (n === t) return `Todos (${t})`;
        return `${n} de ${t}`;
    }

    async discardDraftAndLoadServerTemplate() {
        if (!this.selectedReportId || !this.serverTemplateExists) return;
        const confirmed = await LightningConfirm.open({
            label: 'Cargar plantilla del servidor',
            message: 'Esto descarta el borrador local y aplica la plantilla guardada en Salesforce. Los cambios que estén solo en el navegador se perderán. ¿Continuar?',
            variant: 'header',
            theme: 'warning'
        });
        if (!confirmed) return;
        const rid = this.selectedReportId;
        sessionStorage.removeItem(`pandora_draft_${rid}`);
        this.isFetchingData = true;
        this.fetchStatusText = 'Cargando plantilla desde Salesforce...';
        try {
            const tJson = await getTemplate({ reportId: rid });
            if (!tJson || !String(tJson).trim()) {
                this.showToast('Aviso', 'No hay plantilla en el servidor para este reporte.', 'warning');
                return;
            }
            const parsed = JSON.parse(tJson);
            await this.hydrateLogosIntoConfig(parsed);
            this.loadWorkbookConfig(parsed);
            this.configLoadSource = 'server';
            this.draftSavedTime = null;
            this.rebuildOptions();
            this.updateFilterOptions();
            this.dispatchEvent(new CustomEvent('reportdataloaded', { detail: { reportId: rid } }));
            this.showToast('Listo', 'Se aplicó la plantilla guardada en Salesforce.', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('Error', 'No se pudo cargar la plantilla del servidor.', 'error');
        } finally {
            this.isFetchingData = false;
            this.fetchStatusText = 'Analizando reporte...';
        }
    }
    
    get decoratedSubTables() { 
        return (this.activeSheet && this.activeSheet.subTables ? this.activeSheet.subTables : []).map((sub, idx) => ({ 
            ...sub, 
            indexDisplay: idx + 1, 
            titleDisplay: sub.title ? sub.title : `Pivot #${idx + 1}`,
            needsMetricField: sub.operation === 'SUM' || sub.operation === 'AVG' 
        })); 
    }

    get subTablePreviews() {
        if (!this.activeSheet || !this.reportDataJson || !this.activeSheet.subTables) return [];
        const parsedData = this.getParsedReportData(); if (!parsedData) return [];
        const rows = getRowsForSheet(this.activeSheet, parsedData);
        return this.activeSheet.subTables.filter(s => s.groupByField).map(sub => {
            const pivotObj = calculatePivotData(rows, sub, parsedData, this.baseColumns); const pivotArray = pivotObj.data; const totalVal = pivotObj.total;
            const bg = sub.headerColor || '#263B7A'; const txt = sub.headerTextColor || '#FFFFFF'; const dataBg = sub.dataColor || '#FFFFFF'; const txtData = sub.dataTextColor || '#000000';
            const baseCol = this.baseColumns.find(i => i.apiName === sub.groupByField);
            
            let customTitle = sub.title ? sub.title : `Pivot: ${baseCol ? baseCol.label : sub.groupByField}`;
            const pivotFace = this.normalizeThemeFontName(sub.font || this.getWorkbookFont(), this.getWorkbookFont());
            const fontStyle = `font-family:${this.formatThemeFontCss(pivotFace)};`;
            let tableWidthStyle = sub.autoFit ? 'width: 100%;' : `width: ${sub.manualWidth || 400}px;`;

            let valLabel = 'Recuento'; if (sub.operation !== 'COUNT' && sub.metricField) { const mCol = this.baseColumns.find(c => c.apiName === sub.metricField); valLabel = sub.operation === 'SUM' ? `Suma de ${mCol ? mCol.label : 'Valor'}` : `Promedio de ${mCol ? mCol.label : 'Valor'}`; }
            const isVertical = sub.orientation !== 'horizontal'; let horizontalHeaders = []; let horizontalValues = [];
            
            const headerStyle = `background:${bg};color:${txt};font-weight:bold;padding:8px;border:1px solid #d8dde6;text-align:center;white-space:nowrap;${fontStyle}`;
            const dataStyleLeft = `background:${dataBg};color:${txtData};padding:6px;border:1px solid #eef1f6;font-size:12px;${fontStyle}`;
            const dataStyleCenter = `background:${dataBg};color:${txtData};padding:6px;border:1px solid #eef1f6;text-align:center;font-size:12px;font-weight:bold;white-space:nowrap;${fontStyle}`;
            
            let vRows = [];
            if (!isVertical) { 
                horizontalHeaders = pivotArray.map(p => p.label); horizontalHeaders.push('Total'); 
                horizontalValues = pivotArray.map(p => p.displayValue); horizontalValues.push(sub.operation === 'COUNT' ? totalVal : Number(totalVal).toLocaleString('es-ES', { minimumFractionDigits: 2 })); 
            } else {
                vRows = pivotArray.map(pd => ({ key: `${sub.id}_${pd.label}`, label: pd.label, metricValue: pd.displayValue, styleL: dataStyleLeft, styleC: dataStyleCenter }));
                vRows.push({ key: `${sub.id}_total`, label: 'Total', metricValue: sub.operation === 'COUNT' ? totalVal : Number(totalVal).toLocaleString('es-ES', { minimumFractionDigits: 2 }), styleL: headerStyle, styleC: headerStyle });
            }
            return {
                id: sub.id,
                title: customTitle,
                metricLabel: valLabel,
                isVertical,
                orientationLabel: isVertical ? 'Vertical' : 'Horizontal (Transpuesta)',
                headerStyle,
                dataStyleLeft,
                dataStyleCenter,
                rows: vRows,
                horizontalHeaders,
                horizontalValues,
                customFontStyle: fontStyle,
                customTableWidthStyle: `max-width: 100%; ${tableWidthStyle}`
            };
        });
    }

    get previewRows() {
        if (!this.activeSheet || !this.reportDataJson || !this.isTableSheet) return [];
        const parsedData = this.getParsedReportData(); if (!parsedData) return [];
        const rows = getRowsForSheet(this.activeSheet, parsedData).slice(0, this.previewLimit); const columns = this.previewColumns;
        const searchTerm = (this.isTableSearchOpen && this.tableSearchTerm) ? this.tableSearchTerm.toLowerCase() : '';
        /* X2: banding rows — filas alternadas (zebra). Solo afecta columnas sin
           dataColor custom (para no pisar colores deliberados). */
        const bandedActive = !!(this.activeSheet.settings && this.activeSheet.settings.bandedRows);
        const bandedColor  = (this.activeSheet.settings && this.activeSheet.settings.bandedRowColor) || '#F8FAFC';
        return rows.map((row, rowIndex) => ({ id: `row_${rowIndex}`, rowStyle: `height:${this.activeSheet.settings.dataRowHeight || 24}px;`, cells: columns.map((c, colIndex) => {
            const cIdx = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns.indexOf(c.apiName) : -1;
            const cellData = c.isVirtual ? computeVirtualCellValue(row, c, parsedData) : (cIdx >= 0 ? row.dataCells[cIdx] : null);
            let formattedValue = this.getExcelValue(cellData, c.dataType, c.format, this.activeSheet);
            /* getExcelValue devuelve un Date para fechas (lo usa Excel). Para el preview HTML
               necesitamos un string legible, formateado según c.dateFormat (default = locale). */
            if (formattedValue instanceof Date) {
                formattedValue = this._formatDateForPreview(formattedValue, c.dateFormat || 'auto', c.dataType);
            }
            /* B1: si hay búsqueda activa y la celda contiene el término, marcamos la celda
               con clase de "match" para que el CSS la resalte (amarillo). */
            let cellClass = 'preview-cell';
            if (searchTerm) {
                const haystack = String(formattedValue == null ? '' : formattedValue).toLowerCase();
                if (haystack && haystack.includes(searchTerm)) cellClass += ' preview-cell--match';
            }
            /* B5: el valor crudo se pasa como data-attr para los filtros rápidos. */
            const rawValue = cellData && cellData.value != null ? String(cellData.value) : String(formattedValue == null ? '' : formattedValue);
            /* F3: si la columna está congelada, añadimos style sticky y clase para CSS. */
            if (c.isFrozen) {
                cellClass += ' preview-cell--frozen';
                const isFrozenLast = (colIndex === this.frozenColumnsCount - 1);
                if (isFrozenLast) cellClass += ' preview-cell--frozen-last';
            }
            /* V4: las celdas de columnas virtuales son "editables por doble-click". */
            if (c.isVirtual) cellClass += ' preview-cell--virtual';
            let cellStyle = c.isFrozen
                ? this._mergeStyles(this.buildDataStyle(c, colIndex, columns.length), c.frozenStyle)
                : this.buildDataStyle(c, colIndex, columns.length);
            /* X2: si banding está activo y la columna no tiene dataColor custom,
               aplicamos color alternado en filas impares (zebra striping). */
            if (bandedActive && (rowIndex % 2 === 1)) {
                const hasCustomBg = c.dataColor && c.dataColor.toUpperCase() !== '#FFFFFF';
                if (!hasCustomBg) {
                    cellStyle = cellStyle.replace(/background:\s*#FFFFFF/i, `background:${bandedColor}`);
                    if (!/background:/i.test(cellStyle)) cellStyle += `;background:${bandedColor}`;
                }
            }
            return {
                key: `${rowIndex}_${c.apiName}`,
                showYResize: rowIndex === 0 && colIndex === 0,
                value: formattedValue,
                style: cellStyle,
                cellClass,
                apiName: c.apiName,
                rawValue,
                titleHint: c.isVirtual ? 'Columna virtual — doble-click para editar la fórmula' : undefined
            };
        }) }));
    }

    // PREVISUALIZADOR DE LA FILA DE TOTALES GENERALES
    get previewTotalsRow() {
        if (!this.activeSheet || !this.reportDataJson || !this.isTableSheet || !this.activeSheet.settings.showTotals) return [];
        const parsedData = this.getParsedReportData(); if (!parsedData) return [];
        const rows = getRowsForSheet(this.activeSheet, parsedData);
        const columns = this.previewColumns;
        
        return columns.map((c, index) => {
            let style = this.buildDataStyle(c, index, columns.length);
            if (index === 0) {
                style = style.includes('text-align:') ? style.replace(/text-align:\s*[^;]+/, 'text-align:left') : `${style};text-align:left`;
                return { id: `tot_${c.apiName}`, value: 'Total General', style };
            }
            
            let isNumeric = ['DOUBLE', 'INT', 'CURRENCY', 'PERCENT'].includes((c.dataType||'').toUpperCase()) || c.format === 'number' || c.format === 'currency';
            if (!isNumeric) return { id: `tot_${c.apiName}`, value: '', style };
            
            let sum = rows.reduce((acc, row) => {
                const cIdx = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns.indexOf(c.apiName) : -1;
                const cellData = c.isVirtual ? computeVirtualCellValue(row, c, parsedData) : (cIdx >= 0 ? row.dataCells[cIdx] : null);
                return acc + (Number(cellData?.value) || 0);
            }, 0);
            
            return { id: `tot_${c.apiName}`, value: this.getExcelValue({ value: sum, label: sum }, c.dataType, c.format, this.activeSheet), style };
        });
    }

    openBlendModal() { this.blendReportId = ''; this.showBlendModal = true; }
    closeBlendModal() { this.showBlendModal = false; }
    handleBlendReportChange(e) { this.blendReportId = e.detail.value; }
    get isImportBtnDisabled() { return !this.blendReportId || this.isFetchingData; }

    importBlendedReport() {
        if (!this.blendReportId) return;
        if (!this.reportContexts) this.reportContexts = {};
        
        if (this.reportContexts[this.blendReportId]) {
            const newSheet = this.createSheetObject('detail', 'Datos Mezclados', this.blendReportId, this.reportContexts[this.blendReportId].baseColumns);
            this.workbookConfig = { ...this.workbookConfig, sheets: [...this.workbookConfig.sheets, newSheet] };
            this.switchActiveSheet(newSheet.id);
            this.closeBlendModal();
            this.showToast('Data Blending', 'Reporte importado desde caché instantáneamente.', 'success');
        } else {
            this.closeBlendModal();
            this.fetchReportData(this.blendReportId, true);
        }
    }

    quickExportExcel(event) {
        event.stopPropagation();
        this.autoExportAction = 'excel';
        this.selectedReportId = event.currentTarget.dataset.id;
        this.handleReportChange({ detail: { value: this.selectedReportId } });
    }

    quickExportPpt(event) {
        event.stopPropagation();
        this.autoExportAction = 'ppt';
        this.selectedReportId = event.currentTarget.dataset.id;
        this.handleReportChange({ detail: { value: this.selectedReportId } });
    }

    async guardarPlantilla() {
        if (!this.selectedReportId) { this.showToast('Validación', 'Selecciona un reporte.', 'warning'); return; }
        if (!this.workbookConfig || !this.workbookConfig.sheets.length) { this.showToast('Validación', 'No hay configuración.', 'warning'); return; }

        /* Persistimos los logos en IndexedDB del navegador antes de quitar el base64
           del JSON que va al servidor. Al recargar se rehidratan desde IDB. */
        await this.persistAllLogosFromWorkbook();

        const lightConfig = JSON.parse(JSON.stringify(this.workbookConfig));
        (lightConfig.sheets || []).forEach(sheet => {
            if (sheet.settings && sheet.settings.logoBase64) sheet.settings.logoBase64 = null;
        });
        const configToSave = { ...lightConfig, reportId: this.selectedReportId, savedAt: new Date().toISOString() };
        const jsonStr = JSON.stringify(configToSave);
        const approxLen = jsonStr.length;
        const SF_LONG_TEXT_WARN = 120000;
        if (approxLen > SF_LONG_TEXT_WARN) {
            const kb = Math.round(approxLen / 1000);
            const proceed = await LightningConfirm.open({
                label: 'Configuración muy grande',
                message: `La configuración pesa ~${kb}k caracteres. Salesforce puede rechazar el guardado si supera el límite del campo de texto. ¿Intentar guardar de todas formas?`,
                variant: 'header',
                theme: 'warning'
            });
            if (!proceed) return;
        }

        this.isFetchingData = true;
        /* Si hay variante activa, guardamos en ELLA (no en la default).
           Si no hay variante activa, abrimos el modal "Guardar como nueva variante"
           para forzar al usuario a darle nombre y crearla explícitamente —
           evita que los cambios "huérfanos" se mezclen con otra variante. */
        const cur = (this.availableVariants || []).find(v => v.varianteId === this.currentVariantId);
        if (this.currentVariantId && cur) {
            if (!cur.canEdit) {
                this.isFetchingData = false;
                this.showToast('Permiso', 'No tienes permiso para guardar cambios en esta variante.', 'warning');
                return;
            }
            saveVariant({
                reportId: this.selectedReportId,
                varianteId: cur.varianteId,
                nombre: cur.nombre,
                esDefault: !!cur.esDefault,
                esPublica: !!cur.esPublica,
                jsonConfig: jsonStr
            }).then(() => {
                this.serverTemplateExists = true;
                this.configLoadSource = 'server';
                this.lastTemplateSavedAt = new Date().toISOString();
                this._savedConfigSignature = this._computeWorkbookSignature();
                this.clearDraftFromSession();
                this.showToast('Guardado', `Cambios guardados en «${cur.nombre}».`, 'success');
            }).catch(e => {
                console.error(e);
                this.showToast('Error', 'Fallo al guardar la variante.', 'error');
            }).finally(() => {
                this.isFetchingData = false;
            });
        } else {
            /* Sin variante activa → guardamos en compat default vía saveTemplate.
               Esto cubre el caso del flujo legacy / migración. */
            saveTemplate({ reportId: this.selectedReportId, jsonConfig: jsonStr })
                .then(() => {
                    this.serverTemplateExists = true;
                    this.configLoadSource = 'server';
                    this.lastTemplateSavedAt = new Date().toISOString();
                    this._savedConfigSignature = this._computeWorkbookSignature();
                    this.clearDraftFromSession();
                    this.showToast('Éxito', 'Plantilla guardada correctamente en el servidor.', 'success');
                    /* Refrescamos lista de variantes para que aparezca la recién creada como default. */
                    void this.loadVariantsForCurrentReport();
                })
                .catch(e => {
                    console.error(e);
                    this.showToast('Error', 'Fallo al guardar.', 'error');
                }).finally(() => {
                    this.isFetchingData = false;
                });
        }
    }

    /* ───── Exportar / Importar definición de reporte como archivo JSON ───── */

    exportReportConfigToFile() {
        if (!this.workbookConfig || !this.workbookConfig.sheets.length) {
            this.showToast('Aviso', 'No hay configuración de reporte para exportar.', 'warning');
            return;
        }
        try {
            const configToExport = { ...this.workbookConfig, reportId: this.selectedReportId, savedAt: new Date().toISOString() };
            const wrapper = {
                _meta: {
                    exportedAt: new Date().toISOString(),
                    source: 'reporteKaufmann',
                    reportId: this.selectedReportId || null
                },
                config: configToExport
            };
            const blob = new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const reportLabel = (this.reportOptions.find(r => r.value === this.selectedReportId)?.label || 'reporte').replace(/[^a-zA-Z0-9_-]/g, '_');
            a.href = url;
            a.download = `reporte_config_${reportLabel}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.showToast('Exportado', 'Se descargó la definición del reporte.', 'success');
        } catch (e) {
            console.error('Error exportando configuración de reporte', e);
            this.showToast('Error', 'No se pudo exportar la configuración.', 'error');
        }
    }

    triggerImportReportConfigDialog() {
        const input = this.template.querySelector('input[data-id="import-report-config-file"]');
        if (input) input.click();
    }

    async handleImportReportConfigFile(event) {
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
            if (!config || typeof config !== 'object' || !Array.isArray(config.sheets)) {
                this.showToast('Aviso', 'El archivo no contiene una definición de reporte válida.', 'warning');
                return;
            }
            /* Validación cruzada: rechazar archivos del reportePptBuilder. La huella PPT trae slidesConfig
               y/o pptPresentations pero no columns en sus sheets. */
            const source = parsed && parsed._meta && parsed._meta.source;
            const looksLikePptConfig = Array.isArray(config.slidesConfig) || Array.isArray(config.pptPresentations);
            if ((typeof source === 'string' && source.startsWith('reportePptBuilder')) || looksLikePptConfig) {
                this.showToast(
                    'Archivo del componente incorrecto',
                    'Este archivo es la configuración del PPT, no del Reporte. Llévalo al constructor de Presentaciones (PPT builder) y usa allí la opción de importar configuración.',
                    'warning'
                );
                return;
            }
            const confirmed = await LightningConfirm.open({
                message: 'Esto reemplazará la configuración de la VARIANTE ACTIVA en el editor (todavía no se guarda en Salesforce hasta que confirmes «Guardar Reporte»). Si lo que quieres es traer el backup como una variante nueva sin tocar la actual, cancela aquí y usa «Importar archivo .json como variante» dentro del gestor de Variantes. ¿Continuar?',
                label: 'Importar al editor de la variante activa',
                theme: 'warning'
            });
            if (!confirmed) return;
            this.loadWorkbookConfig(config);
            this.rebuildOptions();
            this.updateFilterOptions();
            this.showToast('Importado', 'Se aplicó la definición del archivo. Usa «Guardar plantilla» para persistirla en Salesforce.', 'success');
        } catch (e) {
            console.error('Error importando configuración de reporte', e);
            this.showToast('Error', 'No se pudo leer o aplicar el archivo de configuración.', 'error');
        }
    }

    handleReportChange(event) {
        this.selectedReportId = event.detail.value;
        this.lastTemplateSavedAt = null;
        this.serverTemplateExists = false;
        this.configLoadSource = 'default';
        this._savedConfigSignature = '';
        if (this.selectedReportId) this.saveToRecentReports(this.selectedReportId);

        this.reportDataJson = ''; this.baseColumns = []; this.summaryOptions = []; this.numericSummaryOptions = []; this.dynamicFilterOptions = [{label: 'Ninguno / Todos', value: ''}];
        this._cachedParsedReportData = null; this._cachedParsedReportKey = null;
        this.activeSheetId = null; this.selectedColumnApiName = null; this.fieldSearchTerm = ''; this.closeFloatingMenu(); this.showFiltersModal = false;
        this.workbookConfig = { version: '2.0', theme: { font: 'Calibri' }, sheets: [] };
        /* V: limpiamos variantes anteriores al cambiar de reporte. */
        this.availableVariants = [];
        this.currentVariantId = null;
        if (this.selectedReportId) {
            this.reportContexts = {};
            /* NUEVO FLUJO (bug-fix p\u00e9rdida de PPT):
               Antes hac\u00edamos fetchReportData inmediato + cargar lista de variantes en paralelo.
               Eso cargaba el reporte SIN variante y permit\u00eda "Avanzar a PPT" en estado
               intermedio (currentVariantId=null), que en BD se traduce a 'default' y termina
               abriendo un dise\u00f1o PPT distinto al que el usuario configur\u00f3.
               Ahora: SOLO listamos variantes y abrimos el picker. El fetchReportData ocurre
               cuando el usuario elige variante en handlePickVariant \u2192 applyVariantById.
               El estado intermedio se muestra con un placeholder en la UI. */
            this._awaitingVariantPick = true;
            void this.loadVariantsForCurrentReport({ openPickerOnFinish: true });
        }
    }

    /* Estado UI: true mientras esperamos que el usuario elija variante para el reporte recién
       seleccionado. Usado para mostrar el placeholder y para reabrir el picker si se cierra. */
    @track _awaitingVariantPick = false;
    get isAwaitingVariantPick() {
        return !!this._awaitingVariantPick && !!this.selectedReportId && !this.currentVariantId;
    }
    /* Reabre el modal picker en caso de que el usuario lo haya cerrado sin elegir. */
    reopenVariantPicker() {
        if (!this.selectedReportId) return;
        this.variantManagerMode = 'picker';
        this.showVariantManagerModal = true;
    }

    /* V: descarga las variantes visibles para el reporte actual.
       Solo refresca el estado. La apertura automática del modal "picker" la
       hace handleReportChange (cuando es la primera carga tras seleccionar reporte). */
    async loadVariantsForCurrentReport({ openPickerOnFinish = false } = {}) {
        if (!this.selectedReportId) return;
        this.variantsBusy = true;
        try {
            const list = await listVariants({ reportId: this.selectedReportId });
            this.availableVariants = (list || []).map(v => ({
                ...v,
                lastModifiedDisplay: v.lastModifiedDate
                    ? new Date(v.lastModifiedDate).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
                    : '—',
                badgeClass: v.esDefault
                    ? 'slds-badge slds-theme_success'
                    : (v.esPublica ? 'slds-badge slds-theme_info' : 'slds-badge'),
                visibilityLabel: v.esPublica ? 'Pública' : 'Privada',
                isCurrent: v.varianteId === this.currentVariantId,
                /* hasPpt lo computa el Apex (listVariants → query secundaria a Plantilla_Geneador_PPT__c).
                   Lo normalizamos para evitar undefined/null en el HTML. */
                hasPpt: v.hasPpt === true,
                pptChipTitle: v.hasPpt === true
                    ? 'Esta variante ya tiene una configuración de PPT guardada. Si avanzas a PPT con esta variante, se cargará ese diseño automáticamente.'
                    : ''
            }));
            if (openPickerOnFinish) {
                this.variantManagerMode = 'picker';
                this.showVariantManagerModal = true;
            }
        } catch (e) {
            console.error('listVariants error', e);
            this.showToast('Aviso', 'No se pudieron listar las variantes guardadas.', 'warning');
        } finally {
            this.variantsBusy = false;
        }
    }

    /* V: handler del clic en una tarjeta del modal de gestión.
       - En modo "picker" cerramos el modal automáticamente tras seleccionar.
       - En modo "manager" lo dejamos abierto (estás solo cambiando la variante activa).
       - Si hay cambios sin guardar en la variante actual, advertimos para no perderlos. */
    async handlePickVariant(event) {
        const vid = event.currentTarget.dataset.id;
        if (!vid) return;
        if (vid === this.currentVariantId) {
            this.showVariantManagerModal = false;
            return;
        }
        /* Solo en modo manager y si ya hay variante activa, comprobamos dirty. */
        if (this.variantManagerMode === 'manager' && this.currentVariantId && this._savedConfigSignature) {
            const dirty = this._computeWorkbookSignature() !== this._savedConfigSignature;
            if (dirty) {
                // eslint-disable-next-line no-alert
                const ok = window.confirm('Tienes cambios sin guardar en la variante actual. ¿Cambiar de variante de todas formas? (los cambios se perderán)');
                if (!ok) return;
            }
        }
        const wasPicker = this.variantManagerMode === 'picker';
        if (wasPicker) this.showVariantManagerModal = false;
        await this.applyVariantById(vid);
    }

    /* V: abre el modal de gestión desde el botón de la cabecera. */
    openVariantManagerModal() {
        if (!this.selectedReportId) {
            this.showToast('Validación', 'Selecciona un reporte primero.', 'warning');
            return;
        }
        this.variantManagerMode = 'manager';
        this.showVariantManagerModal = true;
        /* Refrescamos por si otro usuario añadió/quitó variantes públicas en paralelo. */
        void this.loadVariantsForCurrentReport();
    }
    closeVariantManagerModal() {
        /* Si el modal está abierto en modo "picker" (justo después de elegir un
           reporte y aún no hay variante activa), cerrar la X sin elegir nada deja
           la UI en limbo: spinner "Preparando entorno..." indefinido + banner
           "Elige una variante" sin datos detrás. En ese caso interpretamos el cierre
           como "no quiero entrar todavía", reseteamos la selección y devolvemos al
           usuario al picker de reportes. No hay nada que perder porque el flujo
           picker se ejecuta ANTES de cargar datos.
           En modo "manager" (acceso desde la cabecera con variante ya activa) sigue
           comportándose como antes: solo cierra el modal. */
        const isPickerWithoutVariant = this.variantManagerMode === 'picker' && !this.currentVariantId;
        this.showVariantManagerModal = false;
        /* V-SEARCH: reseteamos el filtro para que la próxima apertura empiece limpia. */
        this.variantSearchQuery = '';
        if (isPickerWithoutVariant) {
            this._resetReportSelection();
        }
    }

    /* V: getters para el título/subtítulo dinámico del modal según el modo. */
    get variantManagerIsPicker() { return this.variantManagerMode === 'picker'; }
    get variantManagerTitle() {
        return this.variantManagerIsPicker
            ? 'Elige una variante de este reporte'
            : 'Gestionar variantes del reporte';
    }
    get variantManagerSubtitle() {
        if (!this.variantManagerIsPicker) {
            return 'Cambia de variante activa, crea nuevas versiones, duplícalas o elimínalas. Cada variante mantiene su propia configuración de columnas, filtros y formato.';
        }
        const n = (this.availableVariants || []).length;
        if (n === 0) return 'Este reporte aún no tiene variantes guardadas. Empieza desde una configuración limpia y guarda tu primera variante cuando termines.';
        if (n === 1) return 'Hay una variante guardada para este reporte. Cárgala para continuar tu trabajo o empieza desde cero para crear una nueva.';
        return 'Tienes varias variantes guardadas. Selecciona la que quieres cargar o empieza desde una configuración limpia.';
    }

    /* V: descarga el JSON de la variante y la aplica al workbookConfig actual.
       NUEVO: dispara fetchReportData si todavía no se han cargado los datos del reporte
       (caso típico tras handleReportChange con el flujo "no_load" que difiere la carga
       de datos hasta la elección de variante). */
    async applyVariantById(varianteId) {
        if (!this.selectedReportId || !varianteId) return;
        this.variantsBusy = true;
        try {
            const jsonStr = await getVariant({ reportId: this.selectedReportId, varianteId });
            if (jsonStr) {
                const parsed = JSON.parse(jsonStr);
                await this.hydrateLogosIntoConfig(parsed);
                /* Conservamos solo el workbookConfig "puro" (sin reportId/savedAt anidados). */
                const { reportId: _r, savedAt: _s, ...wb } = parsed; // eslint-disable-line no-unused-vars
                this.workbookConfig = wb;
                if (this.workbookConfig.sheets && this.workbookConfig.sheets.length) {
                    this.activeSheetId = this.workbookConfig.sheets[0].id;
                }
                this.configLoadSource = 'server';
                this.serverTemplateExists = true;
                this._savedConfigSignature = this._computeWorkbookSignature();
            }
            this.currentVariantId = varianteId;
            this.availableVariants = this.availableVariants.map(v => ({ ...v, isCurrent: v.varianteId === varianteId }));
            /* Liberamos el flag de espera y disparamos la descarga de datos del reporte si
               aún no se ha hecho (flujo nuevo en handleReportChange). */
            this._awaitingVariantPick = false;
            if (!this.reportDataJson) {
                this.fetchReportData(this.selectedReportId, false);
            }
            const v = this.availableVariants.find(x => x.varianteId === varianteId);
            if (v) this.showToast('Variante cargada', `Aplicada: ${v.nombre}`, 'success');
        } catch (e) {
            console.error('applyVariantById error', e);
            this.showToast('Error', 'No se pudo cargar la variante.', 'error');
        } finally {
            this.variantsBusy = false;
        }
    }

    /* "Empezar desde cero" desde el picker: cierra el modal, descarga los datos del reporte
       (necesarios para configurar columnas/filtros) y deja al usuario configurar sin variante.
       Importante: currentVariantId queda null → "Avanzar a PPT" SIGUE bloqueado hasta que
       el usuario guarde como nueva variante. Esto preserva el invariante de que cada PPT
       está asociado a una variante explícita. */
    startFreshNoVariant() {
        this.showVariantManagerModal = false;
        this._awaitingVariantPick = false;
        /* Reset de la config en memoria para que el usuario arranque limpio. */
        this.workbookConfig = { version: '2.0', theme: { font: 'Calibri' }, sheets: [] };
        this.activeSheetId = null;
        this.configLoadSource = 'default';
        this.serverTemplateExists = false;
        this._savedConfigSignature = '';
        if (this.selectedReportId) {
            this.fetchReportData(this.selectedReportId, false);
        }
        this.showToast(
            'Empezando desde cero',
            'Configura el reporte como prefieras y guarda como nueva variante para habilitar el paso a PPT.',
            'info'
        );
    }

    /* V: abre el modal "Guardar como nueva variante" prellenando con la actual. */
    openVariantSaveModal() {
        if (!this.selectedReportId) {
            this.showToast('Validación', 'Selecciona un reporte primero.', 'warning');
            return;
        }
        /* Si veníamos de un flujo de importación incompleto, limpiamos para evitar mezclar configs. */
        this._importedVariantConfig = null;
        this._importedFromReportId = null;
        const current = this.availableVariants.find(v => v.varianteId === this.currentVariantId);
        this.variantSaveDraft = {
            varianteId: '',
            nombre: current ? `${current.nombre} (copia)` : 'Nueva variante',
            esDefault: false,
            esPublica: true,
            activateAfterSave: true
        };
        this.showVariantSaveModal = true;
    }
    /* V: abre el modal en modo "editar metadatos de la variante actual". */
    editCurrentVariant() {
        const current = this.availableVariants.find(v => v.varianteId === this.currentVariantId);
        if (!current) { this.showToast('Validación', 'No hay variante activa.', 'warning'); return; }
        if (!current.canEdit) { this.showToast('Permiso', 'No tienes permiso para editar esta variante.', 'warning'); return; }
        this._importedVariantConfig = null;
        this._importedFromReportId = null;
        this.variantSaveDraft = {
            varianteId: current.varianteId,
            nombre: current.nombre,
            esDefault: current.esDefault,
            esPublica: current.esPublica,
            activateAfterSave: true
        };
        this.showVariantSaveModal = true;
    }
    closeVariantSaveModal() {
        this.showVariantSaveModal = false;
        /* Limpiamos el config importado para que un cierre cancele el flujo de import. */
        this._importedVariantConfig = null;
        this._importedFromReportId = null;
    }
    handleVariantSaveNombre(e) { this.variantSaveDraft = { ...this.variantSaveDraft, nombre: e.target.value }; }
    handleVariantSaveDefault(e) { this.variantSaveDraft = { ...this.variantSaveDraft, esDefault: !!e.target.checked }; }
    handleVariantSavePublica(e) { this.variantSaveDraft = { ...this.variantSaveDraft, esPublica: !!e.target.checked }; }
    handleVariantSaveActivate(e) { this.variantSaveDraft = { ...this.variantSaveDraft, activateAfterSave: !!e.target.checked }; }

    /* V-IMPORT: getters de UI que cambian título/hint del modal de guardar según el flujo (crear/editar/importar). */
    get isImportingVariant() { return !!this._importedVariantConfig; }
    get variantSaveModalTitle() {
        if (this.isImportingVariant) return 'Importar como variante nueva';
        if (this.variantSaveDraft && this.variantSaveDraft.varianteId) return 'Editar variante';
        return 'Guardar como nueva variante';
    }
    get importMismatchNotice() {
        if (!this.isImportingVariant) return null;
        if (!this._importedFromReportId || this._importedFromReportId === this.selectedReportId) return null;
        return 'El archivo viene de un reporte distinto al actual. Las columnas que no existan aquí se ignorarán al cargarla.';
    }
    async submitVariantSave() {
        const d = this.variantSaveDraft;
        if (!d || !d.nombre || !d.nombre.trim()) {
            this.showToast('Validación', 'El nombre de la variante es obligatorio.', 'warning');
            return;
        }
        const isImporting = this.isImportingVariant;
        let configToSave;
        if (isImporting) {
            /* Branch IMPORTAR: usamos el config leído del archivo sin tocar this.workbookConfig.
               Stripeamos logoBase64 para no inflar el payload en SF (los logos se persisten aparte). */
            const lightImported = JSON.parse(JSON.stringify(this._importedVariantConfig));
            (lightImported.sheets || []).forEach(sheet => {
                if (sheet.settings && sheet.settings.logoBase64) sheet.settings.logoBase64 = null;
            });
            configToSave = { ...lightImported, reportId: this.selectedReportId, savedAt: new Date().toISOString() };
        } else {
            if (!this.workbookConfig || !this.workbookConfig.sheets || !this.workbookConfig.sheets.length) {
                this.showToast('Validación', 'Configura al menos una hoja antes de guardar la variante.', 'warning');
                return;
            }
            await this.persistAllLogosFromWorkbook();
            const lightConfig = JSON.parse(JSON.stringify(this.workbookConfig));
            (lightConfig.sheets || []).forEach(sheet => {
                if (sheet.settings && sheet.settings.logoBase64) sheet.settings.logoBase64 = null;
            });
            configToSave = { ...lightConfig, reportId: this.selectedReportId, savedAt: new Date().toISOString() };
        }
        const jsonStr = JSON.stringify(configToSave);
        const wantsActivate = isImporting ? !!d.activateAfterSave : true;
        this.variantsBusy = true;
        try {
            const newId = await saveVariant({
                reportId: this.selectedReportId,
                varianteId: d.varianteId || '',
                nombre: d.nombre.trim(),
                esDefault: !!d.esDefault,
                esPublica: !!d.esPublica,
                jsonConfig: jsonStr
            });
            /* Preservamos el comportamiento original del flujo "guardar config actual": marcamos
               currentVariantId ANTES del refresh para que la UI no parpadee mostrando otra variante
               como activa mientras llega el listado nuevo. En el flujo importing-no-activar, NO se
               toca currentVariantId para no pisar la variante que el usuario tenga abierta. */
            if (wantsActivate && !isImporting) {
                this.currentVariantId = newId;
            }
            this.showVariantSaveModal = false;
            /* Limpiamos el config importado tras éxito para que el siguiente flujo arranque limpio. */
            this._importedVariantConfig = null;
            this._importedFromReportId = null;
            if (isImporting) {
                this.showToast('Importada', `Variante «${d.nombre.trim()}» creada desde archivo.`, 'success');
            } else {
                this.showToast('Variante guardada', `«${d.nombre.trim()}» se guardó correctamente.`, 'success');
            }
            await this.loadVariantsForCurrentReport();
            if (wantsActivate) {
                if (isImporting) {
                    /* Cargar la variante recién creada en el editor (reemplaza workbookConfig en memoria). */
                    await this.applyVariantById(newId);
                } else {
                    /* Doble seguro: tras el refresh re-asignamos para resistir cualquier reset del listado. */
                    this.currentVariantId = newId;
                    this.availableVariants = this.availableVariants.map(v => ({ ...v, isCurrent: v.varianteId === newId }));
                }
            }
        } catch (e) {
            console.error('saveVariant error', e);
            this.showToast('Error', 'No se pudo guardar la variante.', 'error');
        } finally {
            this.variantsBusy = false;
        }
    }

    /* V-IMPORT: dispara el file picker oculto para importar un .json como variante nueva. */
    triggerImportVariantDialog() {
        if (!this.selectedReportId) {
            this.showToast('Validación', 'Selecciona un reporte primero.', 'warning');
            return;
        }
        const input = this.template.querySelector('input[data-id="import-variant-file"]');
        if (input) input.click();
    }

    /* V-IMPORT: lee el .json, valida formato, y abre el modal de guardar precargando datos. */
    async handleImportVariantFile(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.json')) {
            this.showToast('Aviso', 'Selecciona un archivo .json válido.', 'warning');
            return;
        }
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            /* Soportamos ambos shapes: wrapper { _meta, config } y config plano (backups legacy). */
            const config = (parsed && typeof parsed === 'object' && parsed.config) ? parsed.config : parsed;
            if (!config || typeof config !== 'object' || !Array.isArray(config.sheets) || !config.sheets.length) {
                this.showToast('Aviso', 'El archivo no contiene una definición de reporte válida.', 'warning');
                return;
            }
            /* Validación cruzada: rechazar archivos del reportePptBuilder. */
            const source = parsed && parsed._meta && parsed._meta.source;
            const looksLikePptConfig = Array.isArray(config.slidesConfig) || Array.isArray(config.pptPresentations);
            if ((typeof source === 'string' && source.startsWith('reportePptBuilder')) || looksLikePptConfig) {
                this.showToast(
                    'Archivo del componente incorrecto',
                    'Este archivo es la configuración del PPT, no del Reporte. Llévalo al constructor de Presentaciones (PPT builder) y usa allí la opción de importar configuración.',
                    'warning'
                );
                return;
            }
            /* Aviso de tamaño grande antes de seguir. */
            if (text.length > 500000) {
                const okSize = await LightningConfirm.open({
                    label: 'Archivo grande',
                    message: `El archivo pesa ${Math.round(text.length / 1024)} KB. Guardar como variante puede tardar unos segundos. ¿Continuar?`,
                    theme: 'warning'
                });
                if (!okSize) return;
            }
            /* Detectamos reportId del archivo (puede venir en _meta o en config). */
            const fileReportId = (parsed && parsed._meta && parsed._meta.reportId) || config.reportId || null;
            this._importedVariantConfig = config;
            this._importedFromReportId = fileReportId;
            /* Sugerimos un nombre: el del _meta, sino el del archivo sin extensión. */
            const metaName = parsed && parsed._meta && parsed._meta.nombre;
            const fallbackName = file.name.replace(/\.json$/i, '');
            const baseName = (metaName || fallbackName || 'Variante importada').trim().slice(0, 100);
            const isDup = (this.availableVariants || []).some(v => v.nombre === baseName);
            this.variantSaveDraft = {
                varianteId: '',
                nombre: isDup ? `${baseName} (importada)` : baseName,
                esDefault: false,
                esPublica: true,
                activateAfterSave: false
            };
            this.showVariantManagerModal = false;
            this.showVariantSaveModal = true;
        } catch (e) {
            console.error('Error importando archivo de variante', e);
            this.showToast('Error', 'No se pudo leer el archivo JSON.', 'error');
        }
    }

    /* V-IMPORT: descarga el JSON de una variante específica (sin afectar el editor actual). */
    async exportVariantById(event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        const varianteId = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
        if (!varianteId) return;
        const v = (this.availableVariants || []).find(x => x.varianteId === varianteId);
        if (!v) return;
        this.variantsBusy = true;
        try {
            const jsonStr = await getVariant({ reportId: this.selectedReportId, varianteId });
            if (!jsonStr) {
                this.showToast('Aviso', 'La variante no tiene configuración para exportar.', 'warning');
                return;
            }
            let parsedConfig;
            try { parsedConfig = JSON.parse(jsonStr); } catch (_) { parsedConfig = jsonStr; }
            const wrapper = {
                _meta: {
                    exportedAt: new Date().toISOString(),
                    source: 'reporteKaufmann/variant',
                    reportId: this.selectedReportId,
                    varianteId: v.varianteId,
                    nombre: v.nombre,
                    esPublica: v.esPublica,
                    esDefault: v.esDefault
                },
                config: parsedConfig
            };
            const blob = new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = (v.nombre || 'variante').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
            a.href = url;
            a.download = `variante_${safeName}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.showToast('Descargada', `«${v.nombre}» exportada como archivo JSON.`, 'success');
        } catch (e) {
            console.error('exportVariantById error', e);
            this.showToast('Error', 'No se pudo descargar la variante.', 'error');
        } finally {
            this.variantsBusy = false;
        }
    }

    /* V: duplica la variante actual en una nueva privada. Pide nombre por LightningConfirm. */
    async duplicateCurrentVariant() {
        const cur = this.availableVariants.find(v => v.varianteId === this.currentVariantId);
        if (!cur) { this.showToast('Validación', 'No hay variante activa.', 'warning'); return; }
        const nombre = window.prompt('Nombre para la copia:', `${cur.nombre} (copia)`);
        if (!nombre || !nombre.trim()) return;
        this.variantsBusy = true;
        try {
            const newId = await duplicateVariantApex({
                reportId: this.selectedReportId,
                sourceVarianteId: cur.varianteId,
                nuevoNombre: nombre.trim()
            });
            this.showToast('Duplicada', 'Variante duplicada como privada.', 'success');
            await this.loadVariantsForCurrentReport();
            this.currentVariantId = newId;
            this.availableVariants = this.availableVariants.map(v => ({ ...v, isCurrent: v.varianteId === newId }));
        } catch (e) {
            console.error('duplicateVariant error', e);
            this.showToast('Error', 'No se pudo duplicar la variante.', 'error');
        } finally {
            this.variantsBusy = false;
        }
    }

    /* V: elimina la variante seleccionada en la pestaña Variantes (con confirmación). */
    async deleteVariantById(event) {
        const vid = event.currentTarget.dataset.id;
        if (!vid) return;
        const v = this.availableVariants.find(x => x.varianteId === vid);
        if (!v) return;
        const ok = await LightningConfirm.open({
            label: 'Eliminar variante',
            message: `¿Eliminar definitivamente la variante «${v.nombre}»? Esta acción no se puede deshacer.`,
            theme: 'error',
            variant: 'header'
        });
        if (!ok) return;
        this.variantsBusy = true;
        try {
            await deleteVariantApex({ reportId: this.selectedReportId, varianteId: vid });
            this.showToast('Eliminada', `«${v.nombre}» se eliminó correctamente.`, 'success');
            const wasCurrent = this.currentVariantId === vid;
            await this.loadVariantsForCurrentReport();
            if (wasCurrent) {
                const def = this.availableVariants.find(x => x.esDefault) || this.availableVariants[0];
                if (def) await this.applyVariantById(def.varianteId);
            }
        } catch (e) {
            console.error('deleteVariant error', e);
            this.showToast('Error', e.body && e.body.message ? e.body.message : 'No se pudo eliminar la variante.', 'error');
        } finally {
            this.variantsBusy = false;
        }
    }

    /* V: handler del dropdown de la cabecera para cambiar la variante activa. */
    async handleVariantDropdownChange(event) {
        const vid = event.detail.value;
        if (!vid || vid === this.currentVariantId) return;
        await this.applyVariantById(vid);
    }

    /* V: opciones / contadores / labels para los selectores y badges. */
    get variantDropdownOptions() {
        if (!this.availableVariants || !this.availableVariants.length) return [];
        return this.availableVariants.map(v => ({
            label: v.esDefault ? `${v.nombre} (Default)` : v.nombre,
            value: v.varianteId
        }));
    }
    get hasMultipleVariants() { return this.availableVariants && this.availableVariants.length > 1; }
    get hasAnyVariants() { return this.availableVariants && this.availableVariants.length > 0; }
    get availableVariantsCount() { return (this.availableVariants || []).length; }

    /* V-SEARCH: input visible solo cuando hay 6+ variantes (umbral pensado para que sea útil
       sin estorbar en reportes con pocas). Filtra por nombre case-insensitive y normalizando
       acentos para que "logistico" matchee con "Logístico". */
    get showVariantSearch() { return this.availableVariantsCount >= 6; }
    get variantSearchPlaceholder() {
        return `Buscar entre ${this.availableVariantsCount} variantes (por nombre)`;
    }
    _normalizeForSearch(s) {
        return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    }
    get filteredVariants() {
        const all = this.availableVariants || [];
        const q = this._normalizeForSearch(this.variantSearchQuery);
        if (!q) return all;
        return all.filter(v => this._normalizeForSearch(v.nombre).includes(q));
    }
    get filteredVariantsCount() { return (this.filteredVariants || []).length; }
    get hasFilteredVariants() { return this.filteredVariantsCount > 0; }
    get noResultsForFilter() {
        return this.hasAnyVariants && !!this.variantSearchQuery && !this.hasFilteredVariants;
    }
    get noResultsMessage() {
        return `No hay variantes que coincidan con "${this.variantSearchQuery}". Prueba con otro nombre o limpia el buscador.`;
    }
    handleVariantSearchInput(event) {
        this.variantSearchQuery = event.target.value || '';
    }
    clearVariantSearch() {
        this.variantSearchQuery = '';
    }

    get currentVariantLabel() {
        const c = this.availableVariants.find(v => v.varianteId === this.currentVariantId);
        return c ? c.nombre : 'Sin variante activa';
    }
    /* M3: nombre editable de la variante activa. */
    get currentVariantName() {
        if (!this.currentVariantId) return '';
        if (this._variantNameDraft != null) return this._variantNameDraft;
        const c = (this.availableVariants || []).find(v => v.varianteId === this.currentVariantId);
        return c ? c.nombre : '';
    }
    /* M2: label del reporte seleccionado actualmente. */
    get selectedReportLabel() {
        const opt = (this.reportOptions || []).find(r => r.value === this.selectedReportId);
        return opt ? opt.label : this.selectedReportId;
    }
    /* M1: volver a la pantalla de selección de reporte (vaciamos el estado). */
    changeReport() {
        if (!this.selectedReportId) return;
        /* Si hay cambios sin guardar, advertimos. */
        const dirty = this._savedConfigSignature && this._computeWorkbookSignature() !== this._savedConfigSignature;
        const proceedNow = !dirty;
        if (!proceedNow) {
            // eslint-disable-next-line no-alert
            const ok = window.confirm('Tienes cambios sin guardar. ¿Volver a la selección de reporte de todas formas?');
            if (!ok) return;
        }
        this._resetReportSelection();
    }

    /* Vacía todo el estado ligado al reporte actual y vuelve a la pantalla de
       selección. Reutilizado por changeReport() (con confirmación previa) y por
       closeVariantManagerModal() cuando el usuario cierra el picker sin elegir
       variante (no hay nada que perder porque aún no se cargaron datos). */
    _resetReportSelection() {
        this.selectedReportId = '';
        this.workbookConfig = { version: '2.0', theme: { font: 'Calibri', primaryColor: '#0070C0' }, sheets: [] };
        this.activeSheetId = null;
        this.selectedColumnApiName = null;
        this.availableVariants = [];
        this.currentVariantId = null;
        this.showVariantManagerModal = false;
        this.showVariantSaveModal = false;
        this._awaitingVariantPick = false;
        this.reportDataJson = '';
        this.baseColumns = [];
        this.summaryOptions = [];
        this.numericSummaryOptions = [];
        this.dynamicFilterOptions = [{ label: 'Ninguno / Todos', value: '' }];
        this._cachedParsedReportData = null;
        this._cachedParsedReportKey = null;
        this.fieldSearchTerm = '';
        this.lastTemplateSavedAt = null;
        this.serverTemplateExists = false;
        this.configLoadSource = 'default';
        this._savedConfigSignature = '';
    }

    /* M3: edición inline del nombre de la variante.
       - onchange (cada pulsación) → guardamos draft en memoria.
       - onblur → persistimos al servidor si cambió. */
    handleVariantNameInputChange(event) {
        this._variantNameDraft = event.target.value;
    }
    async handleVariantNameInputBlur() {
        const newName = (this._variantNameDraft || '').trim();
        this._variantNameDraft = null;
        if (!newName || !this.currentVariantId) return;
        const cur = (this.availableVariants || []).find(v => v.varianteId === this.currentVariantId);
        if (!cur) return;
        if (newName === cur.nombre) return; /* sin cambios */
        if (!cur.canEdit) {
            this.showToast('Permiso', 'No tienes permiso para renombrar esta variante.', 'warning');
            return;
        }
        /* Reusamos saveVariant pero NO regrabamos toda la config (sólo metadatos).
           Para evitar perder cambios sin guardar del workbook, pasamos el JSON actual
           si la variante ya existe — equivalente a "renombrar y guardar estado actual". */
        await this.persistAllLogosFromWorkbook();
        const lightConfig = JSON.parse(JSON.stringify(this.workbookConfig));
        (lightConfig.sheets || []).forEach(sheet => {
            if (sheet.settings && sheet.settings.logoBase64) sheet.settings.logoBase64 = null;
        });
        const configToSave = { ...lightConfig, reportId: this.selectedReportId, savedAt: new Date().toISOString() };
        const jsonStr = JSON.stringify(configToSave);
        this.variantsBusy = true;
        try {
            await saveVariant({
                reportId: this.selectedReportId,
                varianteId: cur.varianteId,
                nombre: newName,
                esDefault: !!cur.esDefault,
                esPublica: !!cur.esPublica,
                jsonConfig: jsonStr
            });
            this.showToast('Renombrada', `«${cur.nombre}» → «${newName}».`, 'success');
            await this.loadVariantsForCurrentReport();
            this.currentVariantId = cur.varianteId;
            this.availableVariants = this.availableVariants.map(v => ({ ...v, isCurrent: v.varianteId === cur.varianteId }));
        } catch (e) {
            console.error('rename variant error', e);
            this.showToast('Error', 'No se pudo renombrar la variante.', 'error');
        } finally {
            this.variantsBusy = false;
        }
    }

    fetchReportData(reportId, isBlending = false) {
        this.isFetchingData = true;
        this.fetchStatusText = isBlending ? 'Cargando datos para mezclar...' : 'Consultando reporte en Salesforce...';
        if (!this.reportContexts) this.reportContexts = {};

        /* Token incremental: si el usuario cambia de reporte mientras una petición está en curso,
           la respuesta vieja se descarta para no pisar el workbook actual. */
        this._fetchTokenCounter = (this._fetchTokenCounter || 0) + 1;
        const myToken = this._fetchTokenCounter;
        this._activeFetchToken = myToken;
        const isStale = () => this._activeFetchToken !== myToken;

        getReportData({ reportId }).then(result => {
            if (isStale()) { console.info('[Pandora] respuesta obsoleta descartada (getReportData)'); return; }
            this.fetchStatusText = isBlending ? 'Procesando columnas del reporte secundario...' : 'Procesando estructura del reporte...';
            const parsedData = JSON.parse(result); 
            if (parsedData.allData === false || (parsedData.factMap && parsedData.factMap['T!T'] && parsedData.factMap['T!T'].rows && parsedData.factMap['T!T'].rows.length >= 2000)) {
                this.showToast('⚠️ Límite de Salesforce', 'El reporte tiene más de 2.000 registros y ha sido cortado.', 'warning');
            }

            const detailColumns = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns : []; 
            const columnInfo = (parsedData.reportExtendedMetadata && parsedData.reportExtendedMetadata.detailColumnInfo) ? parsedData.reportExtendedMetadata.detailColumnInfo : {};
            const fetchedBaseColumns = detailColumns.map((apiName, index) => { const info = columnInfo[apiName] || {}; return { apiName, label: info.label || apiName, dataType: info.dataType || 'STRING', order: index + 1 }; });
            
            this.reportContexts[reportId] = { json: result, baseColumns: fetchedBaseColumns, parsedData };

            if (isBlending) {
                this.fetchStatusText = 'Creando hoja mezclada...';
                const newSheet = this.createSheetObject('detail', 'Datos Mezclados', reportId, fetchedBaseColumns);
                this.workbookConfig = { ...this.workbookConfig, sheets: [...this.workbookConfig.sheets, newSheet] };
                this.switchActiveSheet(newSheet.id);
                this.showToast('Data Blending', 'Reporte secundario enlazado correctamente.', 'success');
                this.isFetchingData = false;
            } else {
                this.fetchStatusText = 'Buscando plantilla guardada...';
                this.reportDataJson = result;
                this._cachedParsedReportData = parsedData;
                this._cachedParsedReportKey = result;
                this.baseColumns = fetchedBaseColumns;
                return getTemplate({ reportId });
            }
        }).then(async (tJson) => {
            if (isBlending) return;
            if (isStale()) { console.info('[Pandora] respuesta obsoleta descartada (getTemplate)'); return; }
            this.fetchStatusText = 'Aplicando configuración del diseñador...';

            const serverTpl = tJson && String(tJson).trim().length > 0;
            this.serverTemplateExists = Boolean(serverTpl);

            /* Si ya hay una variante activa y workbookConfig cargado por applyVariantById,
               NO sobrescribimos con la plantilla default del reporte. Esto evita perder
               settings de la variante (p.ej. dateFormat por columna). */
            const variantAlreadyApplied = !!this.currentVariantId
                && Array.isArray(this.workbookConfig?.sheets)
                && this.workbookConfig.sheets.length > 0;
            if (variantAlreadyApplied) {
                /* La variante ya pintó el workbook. Solo refrescamos catálogos derivados
                   de baseColumns (que sí dependen del Reports API recién traído). */
                this.draftSavedTime = null;
                /* configLoadSource lo dejó applyVariantById como 'server'; no tocar. */
            } else {
                const draft = sessionStorage.getItem(`pandora_draft_${reportId}`);
                if (draft) {
                    const parsed = JSON.parse(draft);
                    await this.hydrateLogosIntoConfig(parsed);
                    if (isStale()) return;
                    this.loadWorkbookConfig(parsed);
                    this.draftSavedTime = 'Recuperado al cargar';
                    this.configLoadSource = 'draft';
                    this._savedConfigSignature = serverTpl
                        ? this._computeWorkbookSignature(JSON.parse(tJson))
                        : '';
                } else if (tJson) {
                    const parsed = JSON.parse(tJson);
                    await this.hydrateLogosIntoConfig(parsed);
                    if (isStale()) return;
                    this.loadWorkbookConfig(parsed);
                    this.draftSavedTime = null;
                    this.configLoadSource = 'server';
                    this._savedConfigSignature = this._computeWorkbookSignature();
                } else {
                    this.initializeDefaultWorkbook(reportId);
                    this.draftSavedTime = null;
                    this.configLoadSource = 'default';
                    this._savedConfigSignature = '';
                }
            }
            
            this.rebuildOptions();
            this.updateFilterOptions(); 

            // DISPARADOR DE EVENTO PARA AVISAR AL PPT BUILDER
            this.dispatchEvent(new CustomEvent('reportdataloaded', { detail: { reportId: this.selectedReportId } }));

            if (this.autoExportAction) {
                const action = this.autoExportAction;
                const exportReportId = reportId;
                this.autoExportAction = null;
                setTimeout(() => {
                    /* Doble verificación: que el reporte activo siga siendo el mismo y que
                       no haya otra carga en curso. Evita exportar con datos obsoletos. */
                    if (this.selectedReportId !== exportReportId) {
                        console.info('[Pandora] quick export cancelado: cambió el reporte activo');
                        return;
                    }
                    if (this.isFetchingData) {
                        console.info('[Pandora] quick export cancelado: hay otra carga en curso');
                        return;
                    }
                    if (action === 'excel') this.generarExcelLocal();
                    else if (action === 'ppt') this.avanzarAPpt();
                }, 500); 
            }

        }).catch(e => {
            if (isStale()) return;
            console.error(e);
            const detail = (e && e.body && e.body.message) || (Array.isArray(e?.body) && e.body[0]?.message) || e?.message || 'Fallo al cargar reporte.';
            this.showToast('Error', detail, 'error');
        }).finally(() => {
            if (isStale()) return;
            this.fetchStatusText = 'Analizando reporte...';
            this.isFetchingData = false;
        });
    }

    rebuildOptions() {
        this.summaryOptions = [{ label: 'Seleccionar...', value: '' }, ...this.baseColumns.map(c => ({ label: c.label, value: c.apiName }))];
        const numCols = this.baseColumns.filter(c => ['DOUBLE', 'INT', 'CURRENCY', 'PERCENT'].includes((c.dataType||'').toUpperCase())).map(c => ({ label: c.label, value: c.apiName }));
        this.numericSummaryOptions = [{ label: 'Seleccionar...', value: '' }, ...(numCols.length ? numCols : this.baseColumns.map(c => ({ label: c.label, value: c.apiName })))];
    }

    initializeDefaultWorkbook(reportId) {
        const rId = reportId || this.selectedReportId;
        const defaultSheet = this.createSheetObject('detail', 'Datos del Reporte', rId, this.baseColumns);
        this.workbookConfig = { version: '2.0', theme: { font: 'Calibri' }, sheets: [defaultSheet] }; 
        this.activeSheetId = defaultSheet.id; this.selectedColumnApiName = null;
    }

    /**
     * Devuelve las baseColumns correctas para una hoja, según su sourceReportId.
     * Si la hoja pertenece al reporte activo, usa this.baseColumns.
     * Si pertenece a un reporte secundario ya cargado, usa reportContexts[sId].baseColumns.
     * Si el contexto aún no está cargado, usa las columnas que vinieron guardadas en la propia hoja
     * (fallback: mejor mantener la config histórica que perderla).
     */
    getBaseColumnsForSheet(sheet) {
        const sId = sheet?.sourceReportId || this.selectedReportId;
        if (sId === this.selectedReportId) return this.baseColumns;
        const ctx = this.reportContexts?.[sId];
        if (ctx?.baseColumns?.length) return ctx.baseColumns;
        if (Array.isArray(sheet?.columns) && sheet.columns.length) {
            return sheet.columns.map((c, i) => ({
                apiName: c.apiName, label: c.label || c.apiName, dataType: c.dataType || 'STRING',
                order: c.order || i + 1, isVirtual: !!c.isVirtual, vcDef: c.vcDef
            }));
        }
        return [];
    }

    loadWorkbookConfig(savedConfig) {
        const normalizedSheets = (savedConfig.sheets || []).map(sheet => {
            const sId = sheet.sourceReportId || this.selectedReportId;
            /* Columnas virtuales del reporte principal: se inyectan a baseColumns
               para que el panel de campos las muestre y sean editables. Para hojas
               de reportes secundarios no inflamos baseColumns global. */
            if (sheet.columns && sId === this.selectedReportId) {
                sheet.columns.forEach(c => {
                    if (c.isVirtual && !this.baseColumns.some(b => b.apiName === c.apiName)) {
                        this.baseColumns.push({ apiName: c.apiName, label: c.label, dataType: c.dataType, isVirtual: true, vcDef: c.vcDef });
                    }
                });
            }

            const baseForSheet = this.getBaseColumnsForSheet({ sourceReportId: sId, columns: sheet.columns });

            return {
                id: sheet.id || `sheet_${Date.now()}`, name: sheet.name || 'Hoja', type: sheet.type || 'detail', sourceReportId: sId, 
                filters: this.normalizeSheetFilters(sheet.filters || {}),
                settings: { headerHeight: 28, dataRowHeight: 24, freezeHeader: true, autoFilter: true, globalHeaderColor: sheet.settings && sheet.settings.globalHeaderColor ? sheet.settings.globalHeaderColor : '#0070C0', globalDataColor: sheet.settings && sheet.settings.globalDataColor ? sheet.settings.globalDataColor : '#FFFFFF', globalHeaderTextColor: sheet.settings && sheet.settings.globalHeaderTextColor ? sheet.settings.globalHeaderTextColor : '#FFFFFF', globalDataTextColor: sheet.settings && sheet.settings.globalDataTextColor ? sheet.settings.globalDataTextColor : '#000000', tableStartRow: sheet.settings && sheet.settings.tableStartRow ? sheet.settings.tableStartRow : 1, logoBase64: sheet.settings && sheet.settings.logoBase64 ? sheet.settings.logoBase64 : null, logoCol: sheet.settings && sheet.settings.logoCol ? sheet.settings.logoCol : 'A', logoRow: sheet.settings && sheet.settings.logoRow ? sheet.settings.logoRow : 1, logoWidth: sheet.settings && sheet.settings.logoWidth ? sheet.settings.logoWidth : 140, logoHeight: sheet.settings && sheet.settings.logoHeight ? sheet.settings.logoHeight : 45, sortBy: sheet.settings?.sortBy || '', sortDirection: sheet.settings?.sortDirection || 'ASC', showTotals: sheet.settings?.showTotals || false, ...(sheet.settings || {}), blankHyphenAsEmpty: sheet.settings?.blankHyphenAsEmpty !== false, excelLikePreview: !!sheet.settings?.excelLikePreview, previewFontScale: sheet.settings?.previewFontScale === 'compact' || sheet.settings?.previewFontScale === 'large' ? sheet.settings.previewFontScale : 'standard', previewCellWrapWords: !!sheet.settings?.previewCellWrapWords },
                subTables: sheet.subTables || [], columns: baseForSheet.map((b, i) => { const sCol = (sheet.columns||[]).find(c => c.apiName === b.apiName); return { apiName: b.apiName, label: b.label, dataType: b.dataType, alias: sCol && sCol.alias ? sCol.alias : b.label, visible: sCol ? sCol.visible : true, order: sCol && sCol.order ? sCol.order : i+1, width: sCol && sCol.width ? sCol.width : 120, headerColor: sCol && sCol.headerColor ? sCol.headerColor : '', headerTextColor: sCol && sCol.headerTextColor ? sCol.headerTextColor : '', dataColor: sCol && sCol.dataColor ? sCol.dataColor : '', textColor: sCol && sCol.textColor ? sCol.textColor : '', format: sCol && sCol.format ? sCol.format : 'auto', dateFormat: sCol && sCol.dateFormat ? sCol.dateFormat : 'auto', alignment: sCol && sCol.alignment ? sCol.alignment : 'left', isVirtual: b.isVirtual, vcDef: b.vcDef }; })
            };
        });
        this.workbookConfig = { version: '2.0', theme: { font: 'Calibri', ...(savedConfig.theme || {}) }, sheets: normalizedSheets }; 
        this.activeSheetId = normalizedSheets.length ? normalizedSheets[0].id : null; this.selectedColumnApiName = null;
        this.switchActiveSheet(this.activeSheetId);
    }

    openVirtualModal() {
        this.vcName = '';
        this.vcType = 'text';
        this.vcColA = '';
        this.vcOp = ' - ';
        this.vcColB = '';
        this.vcStaticB = '';
        this.vcRegexPattern = '';
        this.vcRegexFlags = '';
        this.vcCaptureGroup = '1';
        this.vcSplitDelimiter = '|';
        this.vcSplitPartIndex = '0';
        this.vcSubStart = '0';
        this.vcSubLength = '';
        this.editingVirtualApiName = null;
        this.showVirtualColModal = true;
    }
    closeVirtualModal() { this.showVirtualColModal = false; }
    handleVcFieldChange(event) { this[event.currentTarget.dataset.field] = event.detail.value; if(event.currentTarget.dataset.field === 'vcType') this.vcOp = this.vcType === 'math' ? '+' : ' - '; }
    handleFieldSearchChange(event) { this.fieldSearchTerm = (event.detail && event.detail.value ? event.detail.value : event.target.value || '').trim(); }

    saveVirtualColumn() {
        if (!this.vcName || !this.vcColA) { this.showToast('Validación', 'El nombre y la Columna A son obligatorios.', 'warning'); return; }
        const apiName = this.editingVirtualApiName || `virtual_${Date.now()}`;

        let vcDef;
        if (this.vcType === 'regex') {
            const patStr = String(this.vcRegexPattern || '').trim();
            if (!patStr) {
                this.showToast('Validación', 'Introduce una expresión regular (patrón).', 'warning');
                return;
            }
            try {
                RegExp(patStr, this.vcRegexFlags || '');
            } catch (_e) {
                this.showToast('Validación', 'La expresión regular no es válida.', 'warning');
                return;
            }
            const cg = Number(this.vcCaptureGroup);
            vcDef = {
                type: 'regex',
                colA: this.vcColA,
                pattern: patStr,
                flags: String(this.vcRegexFlags || ''),
                captureGroup: Number.isFinite(cg) ? cg : 1
            };
        } else if (this.vcType === 'split') {
            vcDef = {
                type: 'split',
                colA: this.vcColA,
                delimiter: this.vcSplitDelimiter != null ? String(this.vcSplitDelimiter) : ',',
                partIndex: Number.isFinite(Number(this.vcSplitPartIndex)) ? Number(this.vcSplitPartIndex) : 0
            };
        } else if (this.vcType === 'substring') {
            const start = Number.isFinite(Number(this.vcSubStart)) ? Number(this.vcSubStart) : 0;
            const lenRaw = String(this.vcSubLength ?? '').trim();
            let lengthField;
            if (lenRaw === '') lengthField = undefined;
            else {
                const ln = Number(lenRaw);
                lengthField = Number.isFinite(ln) && ln >= 0 ? ln : undefined;
            }
            vcDef = { type: 'substring', colA: this.vcColA, start: Math.max(0, start), length: lengthField };
        } else if (this.vcType === 'firstTimestampBlock') {
            vcDef = { type: 'firstTimestampBlock', colA: this.vcColA };
        } else {
            vcDef = { type: this.vcType, colA: this.vcColA, op: this.vcOp, colB: this.vcColB, staticB: this.vcStaticB };
        }

        const newCol = {
            apiName,
            label: this.vcName,
            dataType: this.vcType === 'math' ? 'DOUBLE' : 'STRING',
            isVirtual: true,
            vcDef
        };
        
        if (this.editingVirtualApiName) {
            this.baseColumns = this.baseColumns.map((c) => (c.apiName === apiName ? { ...c, ...newCol } : c));
            this.workbookConfig = {
                ...this.workbookConfig,
                sheets: this.workbookConfig.sheets.map((sheet) => ({
                    ...sheet,
                    columns: (sheet.columns || []).map((c) => {
                        if (c.apiName !== apiName) return c;
                        return {
                            ...c,
                            label: this.vcName,
                            alias: c.alias === c.label ? this.vcName : c.alias,
                            dataType: newCol.dataType,
                            isVirtual: true,
                            vcDef: newCol.vcDef
                        };
                    })
                }))
            };
        } else {
            this.baseColumns = [...this.baseColumns, newCol];
        }
        const sId = this.activeSheet ? this.activeSheet.sourceReportId : this.selectedReportId;
        if(this.reportContexts && this.reportContexts[sId]) { this.reportContexts[sId].baseColumns = this.baseColumns; }

        if (this.activeSheet && !this.editingVirtualApiName) {
            const sheetCols = [...this.activeSheet.columns];
            sheetCols.push({ apiName: apiName, label: this.vcName, dataType: newCol.dataType, alias: this.vcName, visible: true, order: sheetCols.length + 1, width: 120, headerColor: '', headerTextColor: '', dataColor: '', textColor: '', format: 'auto', alignment: 'left', isVirtual: true, vcDef: newCol.vcDef });
            this.updateActiveSheet({ columns: sheetCols });
        }
        
        this.rebuildOptions();
        this.updateFilterOptions();
        this.closeVirtualModal();
        this.showToast('Éxito', this.editingVirtualApiName ? 'Columna Virtual actualizada.' : 'Columna Virtual creada.', 'success');
    }

    /* V4: doble-click sobre el header o las celdas de una columna virtual
       abre el editor de fórmula. Solo dispara si la columna es realmente
       virtual; en caso contrario el evento se ignora (no crashea). */
    handleVirtualColumnDblClick(event) {
        if (!event || !event.currentTarget) return;
        const apiName = event.currentTarget.dataset && event.currentTarget.dataset.apiName;
        if (!apiName) return;
        const col = (this.baseColumns || []).find(c => c.apiName === apiName && c.isVirtual);
        if (!col) return;
        event.stopPropagation();
        event.preventDefault();
        this.editVirtualColumn(event);
    }
    editVirtualColumn(event) {
        event.stopPropagation();
        const apiName = event.currentTarget.dataset.apiName;
        if (!apiName) return;
        const col = (this.baseColumns || []).find((c) => c.apiName === apiName && c.isVirtual);
        if (!col || !col.vcDef) return;
        const def = col.vcDef || {};
        this.editingVirtualApiName = apiName;
        this.vcName = col.label || apiName;
        this.vcType = def.type || 'text';
        this.vcColA = def.colA || '';
        this.vcOp = def.op != null ? String(def.op) : (this.vcType === 'math' ? '+' : ' - ');
        this.vcColB = def.colB || '';
        this.vcStaticB = def.staticB != null ? String(def.staticB) : '';
        this.vcRegexPattern = def.pattern != null ? String(def.pattern) : '';
        this.vcRegexFlags = def.flags != null ? String(def.flags) : '';
        this.vcCaptureGroup = String(def.captureGroup != null ? def.captureGroup : 1);
        this.vcSplitDelimiter = def.delimiter != null ? String(def.delimiter) : '|';
        this.vcSplitPartIndex = String(def.partIndex != null ? def.partIndex : 0);
        this.vcSubStart = String(def.start != null ? def.start : 0);
        this.vcSubLength = def.length != null ? String(def.length) : '';
        this.showVirtualColModal = true;
    }

    /* B3: Duplica una columna virtual existente con un nuevo apiName.
       La columna duplicada hereda la misma definición (vcDef) y se inserta
       en la hoja activa justo a la derecha del original cuando este es
       visible; si no, queda como inactiva al final del listado. */
    duplicateVirtualColumn(event) {
        event.stopPropagation();
        const apiName = event.currentTarget.dataset.apiName;
        if (!apiName) return;
        const original = (this.baseColumns || []).find((c) => c.apiName === apiName && c.isVirtual);
        if (!original || !original.vcDef) return;

        const newApiName = `virtual_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const newLabel = `${original.label || apiName} (copia)`;
        const cloned = {
            apiName: newApiName,
            label: newLabel,
            dataType: original.dataType || 'STRING',
            isVirtual: true,
            vcDef: JSON.parse(JSON.stringify(original.vcDef))
        };

        this.baseColumns = [...this.baseColumns, cloned];
        const sId = this.activeSheet ? this.activeSheet.sourceReportId : this.selectedReportId;
        if (this.reportContexts && this.reportContexts[sId]) {
            this.reportContexts[sId].baseColumns = this.baseColumns;
        }

        /* Inyectamos la columna en todas las hojas que comparten el reporte fuente,
           para que el clon esté disponible igual que el original. La hoja activa
           recibe la columna como visible si el original era visible, justo
           detrás del original; el resto la recibe oculta (visible:false). */
        const updatedSheets = this.workbookConfig.sheets.map((sheet) => {
            if (sheet.sourceReportId !== sId) return sheet;
            const exists = (sheet.columns || []).some((c) => c.apiName === newApiName);
            if (exists) return sheet;
            const cols = [...(sheet.columns || [])];
            const isActive = sheet.id === this.activeSheetId;
            const orig = cols.find((c) => c.apiName === apiName);
            const visible = isActive && orig ? !!orig.visible : false;
            /* Posición: detrás del original (orden = orig.order + 0.5) y luego
               se reasigna toda la lista a enteros consecutivos para mantener
               column.order como entero (estabilidad del sort). */
            const baseOrder = orig ? (orig.order || cols.length + 1) : (cols.length + 1);
            cols.push({
                apiName: newApiName,
                label: newLabel,
                dataType: cloned.dataType,
                alias: newLabel,
                visible,
                order: baseOrder + 0.5,
                width: orig ? orig.width : 120,
                headerColor: orig ? orig.headerColor : '',
                headerTextColor: orig ? orig.headerTextColor : '',
                dataColor: orig ? orig.dataColor : '',
                textColor: orig ? orig.textColor : '',
                format: orig ? orig.format : 'auto',
                alignment: orig ? orig.alignment : 'left',
                isVirtual: true,
                vcDef: cloned.vcDef
            });
            cols.sort((a, b) => (a.order || 0) - (b.order || 0));
            cols.forEach((c, idx) => { c.order = idx + 1; });
            return { ...sheet, columns: cols };
        });

        this.workbookConfig = { ...this.workbookConfig, sheets: updatedSheets };
        this.rebuildOptions();
        this.updateFilterOptions();
        this.saveDraftToSession();
        this.showToast('Duplicado', `Se creó «${newLabel}».`, 'success');
    }

    async deleteVirtualColumn(event) {
        event.stopPropagation();
        const apiName = event.currentTarget.dataset.apiName;
        const confirmed = await LightningConfirm.open({
            label: 'Eliminar columna virtual',
            message: 'Esta acción eliminará la columna virtual de todas las hojas. ¿Deseas continuar?',
            variant: 'header',
            theme: 'warning'
        });
        if (!confirmed) return;
        
        this.baseColumns = this.baseColumns.filter(c => c.apiName !== apiName);
        const sId = this.activeSheet ? this.activeSheet.sourceReportId : this.selectedReportId;
        if(this.reportContexts && this.reportContexts[sId]) { this.reportContexts[sId].baseColumns = this.baseColumns; }

        const updatedSheets = this.workbookConfig.sheets.map(sheet => { return { ...sheet, columns: sheet.columns.filter(c => c.apiName !== apiName) }; });
        
        this.workbookConfig = { ...this.workbookConfig, sheets: updatedSheets };
        if(this.selectedColumnApiName === apiName) { this.selectedColumnApiName = null; this.closeFloatingMenu(); }
        
        this.rebuildOptions();
        this.updateFilterOptions();
        this.saveDraftToSession();
        this.showToast('Eliminado', 'La columna virtual se eliminó de forma permanente.', 'info');
    }

    loadRecentReports() { try { const stored = localStorage.getItem('pandora_recent_reports'); if (stored) this.recentReports = JSON.parse(stored); } catch(e) { console.error(e); } }
    loadFavorites() {
        try {
            const stored = localStorage.getItem(ReporteKaufmann.FAVORITES_STORAGE_KEY);
            const parsed = stored ? JSON.parse(stored) : [];
            this.favoriteReportsList = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error(e);
            this.favoriteReportsList = [];
        }
    }
    saveFavoritesToStorage() {
        try {
            localStorage.setItem(ReporteKaufmann.FAVORITES_STORAGE_KEY, JSON.stringify(this.favoriteReportsList));
        } catch (e) { console.warn('No se pudo guardar favoritos', e); }
    }
    toggleFavoriteReport(event) {
        event.stopPropagation();
        event.preventDefault();
        const id = event.currentTarget.dataset.id;
        if (!id) return;
        const exists = this.favoriteIdSet.has(id);
        if (exists) {
            this.favoriteReportsList = this.favoriteReportsList.filter(f => f.id !== id);
        } else {
            if (this.favoriteReportsList.length >= 30) {
                this.showToast('Favoritos', 'Máximo 30 en acceso rápido. Quita uno para añadir otro.', 'warning');
                return;
            }
            const opt = this.reportOptions.find(o => o.value === id);
            const name = opt ? opt.label : (this.recentReports.find(r => r.id === id)?.name || 'Reporte');
            this.favoriteReportsList = [...this.favoriteReportsList, { id, name }];
        }
        this.saveFavoritesToStorage();
        this.showToast('Favoritos', exists ? 'Quitado de favoritos.' : 'Añadido a accesos rápidos.', 'success');
    }
    saveToRecentReports(reportId) {
        const option = this.reportOptions.find(o => o.value === reportId); const reportName = option ? option.label : 'Reporte Guardado';
        let recents = [...this.recentReports]; recents = recents.filter(r => r.id !== reportId);
        recents.unshift({ id: reportId, name: reportName, date: new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) });
        if(recents.length > 6) recents.pop(); this.recentReports = recents; localStorage.setItem('pandora_recent_reports', JSON.stringify(recents));
    }
    loadRecentReport(event) { const rId = event.currentTarget.dataset.id; this.selectedReportId = rId; this.handleReportChange({ detail: { value: rId } }); }

    /* Clave de draft local. Si hay variante activa, se guarda por (reportId, varianteId)
       para que cada variante mantenga su propio borrador independiente. */
    _draftStorageKey() {
        if (!this.selectedReportId) return null;
        const vid = this.currentVariantId || 'default';
        return `pandora_draft_${this.selectedReportId}__${vid}`;
    }
    saveDraftToSession() {
        if (!this.selectedReportId || !this.workbookConfig) return;
        const storageKey = this._draftStorageKey();
        if (!storageKey) return;
        this._autosaveStatus = 'saving';
        const stamp = () => {
            const now = new Date();
            this.draftSavedTime = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this._lastSavedAt = now.getTime();
            this._autosaveStatus = 'saved';
        };
        try {
            sessionStorage.setItem(storageKey, JSON.stringify(this.workbookConfig));
            stamp();
        } catch (err) {
            void this.persistDraftLightWithLogoIdb(err, storageKey).then(() => stamp()).catch(fallbackErr => {
                console.error('Error guardando draft en sessionStorage:', err, fallbackErr);
                this._autosaveStatus = 'error';
                this.showToast('Aviso', 'No fue posible guardar el borrador local por límite de memoria.', 'warning');
            });
        }
    }
    /* Texto relativo "hace Xs/Xm" para el chip de auto-guardado. Depende de
       _autosaveTick para re-evaluarse periódicamente. */
    get autosaveStatusLabel() {
        // referencia al tick para que el getter sea reactivo al timer
        const _tick = this._autosaveTick; // eslint-disable-line no-unused-vars
        if (this._autosaveStatus === 'saving') return 'Guardando…';
        if (this._autosaveStatus === 'error')  return 'Error al guardar';
        if (this._autosaveStatus === 'idle' || !this._lastSavedAt) return 'Sin cambios';
        const diffSec = Math.max(0, Math.floor((Date.now() - this._lastSavedAt) / 1000));
        if (diffSec < 5)        return 'Guardado ahora';
        if (diffSec < 60)       return `Guardado hace ${diffSec}s`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60)       return `Guardado hace ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        return `Guardado hace ${diffH} h`;
    }
    get autosaveStatusBadgeClass() {
        const base = 'autosave-chip';
        if (this._autosaveStatus === 'saving') return `${base} ${base}--saving`;
        if (this._autosaveStatus === 'error')  return `${base} ${base}--error`;
        if (this._autosaveStatus === 'saved')  return `${base} ${base}--saved`;
        return `${base} ${base}--idle`;
    }
    get autosaveStatusIcon() {
        if (this._autosaveStatus === 'saving') return 'utility:sync';
        if (this._autosaveStatus === 'error')  return 'utility:warning';
        if (this._autosaveStatus === 'saved')  return 'utility:check';
        return 'utility:save';
    }
    get hasAutosaveStatus() { return !!this.selectedReportId; }

    async persistDraftLightWithLogoIdb(originalErr, storageKey) {
        await this.persistAllLogosFromWorkbook();
        const lightConfig = JSON.parse(JSON.stringify(this.workbookConfig));
        (lightConfig.sheets || []).forEach(sheet => {
            if (sheet.settings && sheet.settings.logoBase64) sheet.settings.logoBase64 = null;
        });
        try {
            sessionStorage.setItem(storageKey, JSON.stringify(lightConfig));
            this.showToast('Aviso', 'Borrador guardado sin la imagen embebida (cuota del navegador). El logo se rehidrata desde almacenamiento local al volver a abrir el reporte.', 'warning');
        } catch (e2) {
            console.error('sessionStorage sigue sin espacio tras reducir borrador:', e2);
            this.showToast('Aviso', 'No fue posible guardar el borrador en el navegador; reduce el tamaño de la plantilla o borra datos del sitio.', 'warning');
            throw e2;
        }
    }

    openLogoIndexedDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(ReporteKaufmann.LOGO_IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(ReporteKaufmann.LOGO_IDB_STORE)) {
                    db.createObjectStore(ReporteKaufmann.LOGO_IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async persistLogoToIndexedDb(reportId, sheetId, dataUrl) {
        if (!reportId || !sheetId || !dataUrl) return;
        try {
            const db = await this.openLogoIndexedDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(ReporteKaufmann.LOGO_IDB_STORE, 'readwrite');
                tx.objectStore(ReporteKaufmann.LOGO_IDB_STORE).put(dataUrl, `${reportId}::${sheetId}`);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            db.close();
        } catch (e) {
            console.warn('No se pudo guardar logo en IndexedDB', e);
        }
    }

    async loadLogoFromIndexedDb(reportId, sheetId) {
        if (!reportId || !sheetId) return null;
        try {
            const db = await this.openLogoIndexedDb();
            const out = await new Promise((resolve, reject) => {
                const tx = db.transaction(ReporteKaufmann.LOGO_IDB_STORE, 'readonly');
                const q = tx.objectStore(ReporteKaufmann.LOGO_IDB_STORE).get(`${reportId}::${sheetId}`);
                q.onsuccess = () => resolve(q.result || null);
                q.onerror = () => reject(q.error);
            });
            db.close();
            return out;
        } catch (e) {
            console.warn('No se pudo leer logo desde IndexedDB', e);
            return null;
        }
    }

    async deleteLogoFromIndexedDb(reportId, sheetId) {
        if (!reportId || !sheetId) return;
        try {
            const db = await this.openLogoIndexedDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(ReporteKaufmann.LOGO_IDB_STORE, 'readwrite');
                tx.objectStore(ReporteKaufmann.LOGO_IDB_STORE).delete(`${reportId}::${sheetId}`);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            db.close();
        } catch (e) {
            console.warn('No se pudo eliminar logo en IndexedDB', e);
        }
    }

    async persistAllLogosFromWorkbook() {
        const reportId = this.selectedReportId;
        if (!reportId || !this.workbookConfig || !this.workbookConfig.sheets) return;
        for (const sheet of this.workbookConfig.sheets) {
            const logo = sheet.settings && sheet.settings.logoBase64;
            if (logo && sheet.id) {
                await this.persistLogoToIndexedDb(reportId, sheet.id, logo);
            }
        }
    }

    async hydrateLogosIntoConfig(config) {
        const reportId = this.selectedReportId;
        if (!reportId || !config || !config.sheets) return;
        for (const sheet of config.sheets) {
            if (sheet.settings && sheet.settings.logoBase64) continue;
            if (!sheet.id) continue;
            const url = await this.loadLogoFromIndexedDb(reportId, sheet.id);
            if (url) {
                sheet.settings = { ...(sheet.settings || {}), logoBase64: url };
            }
        }
    }

    addExcelLogoToWorksheet(workbook, worksheet, sheetConfig, effectiveTableStart1Based) {
        const dataUrl = sheetConfig.settings && sheetConfig.settings.logoBase64;
        if (!dataUrl || typeof dataUrl !== 'string') return;
        const parsed = parseImageDataUrl(dataUrl);
        if (!parsed) return;
        let ext = parsed.extension;
        if (ext === 'webp') {
            console.warn('Logo WEBP omitido en Excel; vuelve a cargar el logo o usa PNG/JPEG.');
            return;
        }
        const ex = ext === 'jpg' ? 'jpeg' : ext;
        if (ex !== 'jpeg' && ex !== 'png' && ex !== 'gif') return;
        const s = sheetConfig.settings;
        const w = Number(s.logoWidth) || 140;
        const h = Number(s.logoHeight) || 45;
        /* Y4: si tenemos logoX/logoY (drag libre), usamos anchor fraccionario
           — convertimos px del preview a posición de celda Excel:
               · ancho de columna por defecto: 64 px (8.43 chars * 7.6 px).
               · alto de fila por defecto: 20 px (15 pt).
           Si no, caemos al flujo legacy basado en logoCol/logoRow. */
        let tlCol, tlRow;
        if (s.logoX != null || s.logoY != null) {
            const x = Number(s.logoX) || 0;
            const y = Number(s.logoY) || 0;
            const COL_PX = 64;   /* aprox ancho columna default */
            const ROW_PX = 20;   /* aprox alto fila default */
            tlCol = Math.max(0, x / COL_PX);
            tlRow = Math.max(0, y / ROW_PX);
        } else {
            const colLetter = ((s.logoCol || 'A').toUpperCase()).charAt(0);
            tlCol = Math.max(0, Math.min(25, colLetter.charCodeAt(0) - 65));
            const logoRowSetting = Number(s.logoRow) || 1;
            const maxRowAboveTable = Math.max(1, effectiveTableStart1Based - 1);
            tlRow = Math.min(logoRowSetting, maxRowAboveTable) - 1;
        }
        try {
            const imageId = workbook.addImage({
                base64: parsed.base64,
                extension: ex
            });
            worksheet.addImage(imageId, {
                tl: { col: tlCol, row: tlRow },
                ext: { width: w, height: h }
            });
        } catch (e) {
            console.error('No se pudo incrustar logo en Excel', e);
        }
    }
    clearDraftFromSession() {
        if (!this.selectedReportId) return;
        const key = this._draftStorageKey();
        if (key) sessionStorage.removeItem(key);
        /* Compat: limpiamos también la clave legacy sin varianteId. */
        sessionStorage.removeItem(`pandora_draft_${this.selectedReportId}`);
        this.draftSavedTime = null;
    }

    toggleLeftPanel() { this.isLeftPanelHidden = !this.isLeftPanelHidden; }
    toggleFullScreen() { this.isFullScreen = !this.isFullScreen; }

    loadUiModePreference() {
        try {
            const experienceOk = sessionStorage.getItem(ReporteKaufmann.EXPERIENCE_SESSION_KEY) === '1';
            if (!experienceOk) {
                this.uiMode = 'basic';
                return;
            }
            const storedMode = sessionStorage.getItem(ReporteKaufmann.UI_MODE_STORAGE_KEY);
            if (storedMode === 'basic' || storedMode === 'advanced') this.uiMode = storedMode;
        } catch (e) {
            console.warn('No se pudo leer preferencia de modo UI.', e);
            this.uiMode = 'basic';
        }
    }
    saveUiModePreference() {
        try {
            sessionStorage.setItem(ReporteKaufmann.UI_MODE_STORAGE_KEY, this.uiMode);
        } catch (e) {
            console.warn('No se pudo guardar preferencia de modo UI.', e);
        }
    }
    activateWorkbookExperience() {
        try {
            sessionStorage.setItem(ReporteKaufmann.EXPERIENCE_SESSION_KEY, '1');
        } catch (e) {
            console.warn('No se pudo marcar sesión de experiencia libro.', e);
        }
        this.uiMode = 'advanced';
        this.saveUiModePreference();
        this.showToast(
            'Herramientas de libro activadas',
            'Ya puedes usar logo en Excel/PDF, pivots en la hoja y combinar otro informe. Ocultas de nuevo con un clic.',
            'success'
        );
    }
    deactivateWorkbookExperience() {
        try {
            sessionStorage.removeItem(ReporteKaufmann.EXPERIENCE_SESSION_KEY);
        } catch (e) { /* ignore */ }
        this.uiMode = 'basic';
        this.saveUiModePreference();
        this.showToast('Modo simplificado', 'Logo, pivots integrados y combinar informes quedaron ocultos.', 'info');
    }
    handleDensityChange(event) {
        this.densityMode = event.detail.value;
        this.saveDensityPreference();
    }
    loadDensityPreference() {
        try {
            const stored = sessionStorage.getItem(ReporteKaufmann.UI_DENSITY_STORAGE_KEY);
            if (stored === 'comfortable' || stored === 'compact') this.densityMode = stored;
        } catch (e) {
            console.warn('No se pudo leer densidad de UI.', e);
        }
    }
    saveDensityPreference() {
        try {
            sessionStorage.setItem(ReporteKaufmann.UI_DENSITY_STORAGE_KEY, this.densityMode);
        } catch (e) {
            console.warn('No se pudo guardar densidad de UI.', e);
        }
    }
    showAllColumnsInSheet() {
        if (!this.activeSheet || !this.activeSheet.columns) {
            this.showToast('Aviso', 'Selecciona un reporte con hoja activa.', 'warning');
            return;
        }
        const updated = this.activeSheet.columns.map(c => ({ ...c, visible: true }));
        this.updateActiveSheet({ columns: updated });
        this.showToast('Columnas', 'Todas las columnas quedaron visibles en esta hoja.', 'success');
    }

    handleLayoutPresetChange(event) {
        const v = event.detail.value;
        if (!v || !this.activeSheet) return;
        if (v === 'full_report_order') this.applyPresetFullReportOrder();
        else if (v === 'focus_eight') this.applyPresetFocusEight();
        else if (v === 'width_standard') this.applyPresetWidthStandard();
        this.layoutPresetValue = '';
        Promise.resolve().then(() => { this.layoutPresetValue = ''; });
    }
    applyPresetFullReportOrder() {
        if (!this.activeSheet || !this.activeSheet.columns) return;
        const colMap = new Map(this.activeSheet.columns.map(c => [c.apiName, { ...c }]));
        const newCols = [];
        let order = 1;
        (this.baseColumns || []).forEach(bc => {
            if (colMap.has(bc.apiName)) {
                const c = colMap.get(bc.apiName);
                colMap.delete(bc.apiName);
                newCols.push({ ...c, visible: true, order: order++, width: c.width > 0 ? c.width : 120 });
            }
        });
        colMap.forEach(c => { newCols.push({ ...c, visible: true, order: order++ }); });
        this.updateActiveSheet({ columns: newCols });
        this.showToast('Plantilla', 'Orden del reporte restaurado y todas las columnas visibles.', 'success');
    }
    applyPresetFocusEight() {
        if (!this.activeSheet || !this.activeSheet.columns) return;
        const sorted = [...this.activeSheet.columns].sort((a, b) => a.order - b.order);
        const newCols = sorted.map((c, i) => ({ ...c, visible: i < 8 }));
        this.updateActiveSheet({ columns: newCols });
        this.showToast('Plantilla', 'Solo las primeras 8 columnas (por orden actual) quedaron visibles.', 'success');
    }
    applyPresetWidthStandard() {
        if (!this.activeSheet || !this.activeSheet.columns) return;
        const newCols = this.activeSheet.columns.map(c => ({ ...c, width: 120 }));
        this.updateActiveSheet({ columns: newCols });
        this.showToast('Plantilla', 'Todos los anchos de columna fijados en 120 px.', 'success');
    }

    handleGlobalKeydown(event) {
        if (event.key === 'Escape') {
            if (this.quickFilterMenuVisible) { event.preventDefault(); this.closeQuickFilterMenu(); return; }
            if (this.isTableSearchOpen) { event.preventDefault(); this.closeTableSearch(); return; }
            if (this.showFiltersModal) { event.preventDefault(); this.closeFiltersModal(); return; }
            if (this.showBlendModal) { event.preventDefault(); this.closeBlendModal(); return; }
            if (this.showVirtualColModal) { event.preventDefault(); this.closeVirtualModal(); return; }
            if (this.showNewSheetModal) { event.preventDefault(); this.closeNewSheetModal(); return; }
            if (this.showStudioSettingsModal) { event.preventDefault(); this.closeStudioSettingsModal(); return; }
            if (this.showChartModal) { event.preventDefault(); this.closeChartModal(); return; }
            if (this.showPrintPreviewModal) { event.preventDefault(); this.closePrintPreviewModal(); return; }
            if (this.isSavedViewsMenuOpen) { event.preventDefault(); this.closeSavedViewsMenu(); return; }
        }
        if (!this.selectedReportId || this.showBlendModal || this.showVirtualColModal || this.showNewSheetModal || this.showFiltersModal || this.showStudioSettingsModal || this.showChartModal || this.showPrintPreviewModal) return;
        const tag = (event.target && event.target.tagName) ? event.target.tagName : '';
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        /* B1: Ctrl+Shift+F abre la búsqueda en la tabla del lienzo (preview).
           Mantenemos Ctrl+F / / para enfocar el search del panel izquierdo. */
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'f' || event.key === 'F')) {
            if (isTyping && this.template.activeElement && this.template.activeElement.closest && this.template.activeElement.closest('[data-table-search]')) {
                /* Si ya está en el input de búsqueda, dejamos pasar para evitar bucle. */
                return;
            }
            event.preventDefault();
            this.openTableSearch();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
            if (isTyping) return;
            event.preventDefault();
            this.focusFieldSearchInput();
            return;
        }
        if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (isTyping) return;
            event.preventDefault();
            this.focusFieldSearchInput();
        }
        /* R4: atajos de zoom Ctrl + / Ctrl - / Ctrl 0. */
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            if (event.key === '+' || event.key === '=') {
                if (isTyping) return;
                event.preventDefault();
                this.handleZoomIn();
                return;
            }
            if (event.key === '-' || event.key === '_') {
                if (isTyping) return;
                event.preventDefault();
                this.handleZoomOut();
                return;
            }
            if (event.key === '0') {
                if (isTyping) return;
                event.preventDefault();
                this.handleZoomReset();
                return;
            }
        }
    }
    focusFieldSearchInput() {
        const host = this.template.querySelector('lightning-input[data-field-search]');
        if (host && typeof host.focus === 'function') host.focus();
    }

    /* B1: búsqueda en tabla. La barra flotante vive sobre el lienzo;
       el resaltado de matches sale de previewRows (cell.cellClass). */
    get tableSearchMatchCount() {
        if (!this.isTableSearchOpen || !this.tableSearchTerm) return 0;
        let total = 0;
        for (const row of this.previewRows) {
            for (const cell of row.cells) {
                if (cell.cellClass && cell.cellClass.indexOf('preview-cell--match') >= 0) total += 1;
            }
        }
        return total;
    }
    get tableSearchSummary() {
        const n = this.tableSearchMatchCount;
        if (!this.tableSearchTerm) return 'Escribe para buscar';
        return n === 1 ? '1 coincidencia' : `${n} coincidencias`;
    }
    openTableSearch() {
        if (!this.isTableSheet || !this.excelPreviewVisible) {
            this.showToast('Buscar', 'Selecciona una hoja de tipo tabla detalle con datos para usar la búsqueda.', 'info');
            return;
        }
        this.isTableSearchOpen = true;
        /* Esperamos al render para enfocar el input. */
        Promise.resolve().then(() => {
            const inp = this.template.querySelector('[data-table-search] input') || this.template.querySelector('lightning-input[data-table-search]');
            if (inp && typeof inp.focus === 'function') inp.focus();
        });
    }
    closeTableSearch() {
        this.isTableSearchOpen = false;
        this.tableSearchTerm = '';
    }
    handleTableSearchInput(event) {
        const val = event.detail && event.detail.value != null ? event.detail.value : (event.target ? event.target.value : '');
        this.tableSearchTerm = String(val || '');
    }
    toggleTableSearch() {
        if (this.isTableSearchOpen) this.closeTableSearch();
        else this.openTableSearch();
    }

    /* ─── B5: filtros rápidos por click derecho sobre una celda del lienzo ───
       Abre un menú flotante con tres acciones que añaden/quitan condiciones
       en activeSheet.filters (eq, neq, limpiar). Reutiliza la lógica existente
       de normalizeSheetFilters para no duplicar formato. */
    handleCellContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!this.activeSheet) return;
        const apiName = event.currentTarget.dataset.apiName;
        const rawValue = event.currentTarget.dataset.rawValue;
        if (!apiName) return;
        const col = this.baseColumns.find(c => c.apiName === apiName);
        if (!col) return;
        /* Posicionamos el menú cerca del cursor, pero acotado al viewport
           para que no se salga por la derecha/abajo. */
        const winW = window.innerWidth || 800;
        const winH = window.innerHeight || 600;
        const menuW = 230;
        const menuH = 160;
        const left = Math.min(event.clientX, Math.max(0, winW - menuW - 8));
        const top  = Math.min(event.clientY, Math.max(0, winH - menuH - 8));
        this.quickFilterContext = {
            apiName,
            label: col.label || apiName,
            value: rawValue != null ? rawValue : '',
            displayValue: this._truncateForLabel(rawValue, 32)
        };
        this.quickFilterMenuPos = `position:fixed; top:${top}px; left:${left}px;`;
        this.quickFilterMenuVisible = true;
        /* Listener global para cerrar al primer click fuera. Usamos 'click'
           (no mousedown) para que los onclick de los items se ejecuten primero
           y comprobamos composedPath() porque en shadow DOM event.target es
           el componente host, no el botón real. */
        if (!this._boundQuickFilterDocClick) {
            this._boundQuickFilterDocClick = this.handleQuickFilterDocClick.bind(this);
        }
        Promise.resolve().then(() => {
            document.addEventListener('click', this._boundQuickFilterDocClick, false);
        });
    }
    handleQuickFilterDocClick(event) {
        const menu = this.template.querySelector('.quick-filter-menu');
        if (!menu) { this.closeQuickFilterMenu(); return; }
        const path = (typeof event.composedPath === 'function') ? event.composedPath() : [];
        if (path && path.indexOf(menu) >= 0) return;
        this.closeQuickFilterMenu();
    }
    closeQuickFilterMenu() {
        this.quickFilterMenuVisible = false;
        this.quickFilterContext = null;
        if (this._boundQuickFilterDocClick) {
            document.removeEventListener('click', this._boundQuickFilterDocClick, false);
        }
    }
    _truncateForLabel(value, max) {
        const s = String(value == null ? '' : value);
        if (s.length <= max) return s;
        return s.slice(0, Math.max(1, max - 1)) + '…';
    }
    get quickFilterLabelEq()  { return this.quickFilterContext ? `Filtrar por «${this.quickFilterContext.displayValue}»` : ''; }
    get quickFilterLabelNeq() { return this.quickFilterContext ? `Excluir «${this.quickFilterContext.displayValue}»` : ''; }
    get quickFilterLabelClear() { return this.quickFilterContext ? `Quitar filtros de «${this.quickFilterContext.label}»` : ''; }
    applyQuickFilterEq()  { this._applyQuickFilterCommon('eq');  }
    applyQuickFilterNeq() { this._applyQuickFilterCommon('neq'); }
    _applyQuickFilterCommon(operator) {
        if (!this.activeSheet || !this.quickFilterContext) { this.closeQuickFilterMenu(); return; }
        const { apiName, value } = this.quickFilterContext;
        const isBlank = value == null || String(value).trim() === '';
        /* Si la celda está vacía, usamos los operadores empty / notEmpty
           que no necesitan filterValue para ser considerados "usables". */
        const effectiveOp = isBlank
            ? (operator === 'eq' ? 'empty' : 'notEmpty')
            : operator;
        const norm = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = (norm.items || []).filter(f =>
            /* Quitamos el placeholder vacío que normalizeSheetFilters inyecta
               cuando no había filtros, para no acumular ruido al añadir. */
            (f.filterColumn || (f.filterValue && String(f.filterValue).trim()) ||
             f.operator === 'empty' || f.operator === 'notEmpty')
        );
        /* Si ya existe un filtro idéntico, no duplicamos. */
        const existing = items.find(f =>
            f.filterColumn === apiName
            && f.operator === effectiveOp
            && String(f.filterValue || '') === String(isBlank ? '' : value)
        );
        if (!existing) {
            items.push({
                id: `flt_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
                logic: 'AND',
                filterColumn: apiName,
                operator: effectiveOp,
                filterValue: isBlank ? '' : String(value),
                filterValue2: ''
            });
        }
        const updatedFilters = this.normalizeSheetFilters({ ...norm, items });
        this.updateActiveSheet({ filters: updatedFilters });
        this.closeQuickFilterMenu();
        const opLabel = operator === 'eq' ? 'Filtro añadido' : 'Exclusión añadida';
        const valDescr = isBlank ? '(vacío)' : this._truncateForLabel(value, 60);
        this.showToast(opLabel, valDescr, 'success');
    }
    clearQuickFilterColumn() {
        if (!this.activeSheet || !this.quickFilterContext) { this.closeQuickFilterMenu(); return; }
        const { apiName, label } = this.quickFilterContext;
        const norm = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = norm.items.filter(f => f.filterColumn !== apiName);
        const updatedFilters = this.normalizeSheetFilters({ ...norm, items });
        this.updateActiveSheet({ filters: updatedFilters });
        this.closeQuickFilterMenu();
        this.showToast('Filtros quitados', `Se limpiaron los filtros de «${label}».`, 'info');
    }

    /* ─── B6: Modo oscuro ─────────────────────────────────────────────
       Persiste en localStorage y se aplica como clase en .pandora-app.
       (static DARK_MODE_STORAGE_KEY declarado arriba con las otras keys.) */
    loadDarkModePreference() {
        try {
            const v = localStorage.getItem(ReporteKaufmann.DARK_MODE_STORAGE_KEY);
            this.isDarkMode = v === '1';
        } catch (_e) { this.isDarkMode = false; }
    }
    saveDarkModePreference() {
        try { localStorage.setItem(ReporteKaufmann.DARK_MODE_STORAGE_KEY, this.isDarkMode ? '1' : '0'); } catch (_e) { /* no-op */ }
    }
    handleDarkModeToggle(event) {
        this.isDarkMode = !!event.target.checked;
        this.saveDarkModePreference();
    }

    setActiveSheetFromEvent(event) { const sheetId = event.currentTarget.dataset.sheetId; if (!sheetId) return; this.switchActiveSheet(sheetId); }
    
    switchActiveSheet(sheetId) {
        this.activeSheetId = sheetId;
        this.selectedColumnApiName = null;
        this.closeFloatingMenu();
        this.showFiltersModal = false;
        const sheet = this.activeSheet;
        if (sheet && sheet.sourceReportId && this.reportContexts && this.reportContexts[sheet.sourceReportId]) {
            this.reportDataJson = this.reportContexts[sheet.sourceReportId].json;
            this.baseColumns = this.reportContexts[sheet.sourceReportId].baseColumns;
            this.rebuildOptions();
        }
        this.updateFilterOptions(); 
    }

    async deleteSheetFromEvent(event) {
        event.preventDefault();
        event.stopPropagation();
        const sheetId = event.currentTarget.dataset.sheetId;
        if (!sheetId) return;
        if (!this.workbookConfig.sheets || this.workbookConfig.sheets.length <= 1) {
            this.showToast('Validación', 'Debe existir al menos una hoja.', 'warning');
            return;
        }
        const sheet = this.workbookConfig.sheets.find((s) => s.id === sheetId);
        const label = sheet?.name || 'esta hoja';
        const ok = await LightningConfirm.open({
            message: `¿Eliminar la hoja «${label}»? Se pierden sus columnas y ajustes en el borrador local.`,
            variant: 'header',
            label: 'Eliminar hoja',
            theme: 'warning'
        });
        if (!ok) return;
        const remainingSheets = this.workbookConfig.sheets.filter((sh) => sh.id !== sheetId);
        this.workbookConfig = { ...this.workbookConfig, sheets: remainingSheets };
        if (this.activeSheetId === sheetId) {
            this.switchActiveSheet(remainingSheets[0].id);
        }
        this.selectedColumnApiName = null;
        this.closeFloatingMenu();
        this.saveDraftToSession();
    }
    openNewSheetModal() { this.newSheetName = 'Nueva hoja'; this.newSheetType = 'detail'; this.showNewSheetModal = true; }
    closeNewSheetModal() { this.showNewSheetModal = false; }
    handleNewSheetNameChange(event) { this.newSheetName = event.target.value; }
    handleNewSheetTypeChange(event) { this.newSheetType = event.detail.value; }
    
    createSheetObject(type, name, sourceReportId, sourceColumns) { 
        const sId = sourceReportId || this.selectedReportId;
        const cols = sourceColumns || this.baseColumns;
        return { 
            id: this.generateSheetId(), name: name, type: type, sourceReportId: sId, filters: this.normalizeSheetFilters({}), settings: { headerHeight: 28, dataRowHeight: 24, freezeHeader: true, autoFilter: true, globalHeaderColor: '#0070C0', globalDataColor: '#FFFFFF', globalHeaderTextColor: '#FFFFFF', globalDataTextColor: '#000000', tableStartRow: 1, logoBase64: null, logoCol: 'A', logoRow: 1, logoWidth: 140, logoHeight: 45, sortBy: '', sortDirection: 'ASC', showTotals: false, blankHyphenAsEmpty: true, excelLikePreview: false, previewFontScale: 'standard', previewCellWrapWords: true, frozenColumns: 0, showRowCount: false, bandedRows: false, bandedRowColor: '#F8FAFC', borderStyle: 'all', borderColor: '#D8DDE6', borderWidth: 1 }, subTables: [], charts: [], columns: cols.map((c, i) => ({ apiName: c.apiName, label: c.label, dataType: c.dataType, alias: c.label, visible: true, order: i + 1, width: 120, headerColor: '', headerTextColor: '', dataColor: '', textColor: '', format: 'auto', alignment: 'left', isVirtual: c.isVirtual, vcDef: c.vcDef })) 
        }; 
    }
    
    createSheetFromModal() { const cleanName = this.newSheetName && this.newSheetName.trim() ? this.newSheetName.trim() : 'Nueva hoja'; const sId = this.activeSheet ? this.activeSheet.sourceReportId : this.selectedReportId; const newSheet = this.createSheetObject(this.newSheetType, cleanName, sId, this.baseColumns); this.workbookConfig = { ...this.workbookConfig, sheets: [...this.workbookConfig.sheets, newSheet] }; this.switchActiveSheet(newSheet.id); this.showNewSheetModal = false; this.saveDraftToSession(); }
    handleActiveSheetNameChange(event) { this.updateActiveSheet({ name: event.target.value }); }
    handleActiveSheetTypeChange(event) { const newType = event.detail.value; this.updateActiveSheet({ type: newType, subTables: [] }); this.selectedColumnApiName = null; }
    
    selectColumnFromEvent(event) { const apiName = event.currentTarget.dataset.apiName; if (!apiName) return; this.selectedColumnApiName = apiName; const rect = event.currentTarget.getBoundingClientRect(); this.floatingMenuPos = `top: ${rect.bottom + 8}px; left: ${rect.left + 10}px;`; this.isFloatingMenuVisible = true; }
    deselectColumn() { this.selectedColumnApiName = null; this.closeFloatingMenu(); }
    closeFloatingMenu() { this.isFloatingMenuVisible = false; }
    handleCanvasScroll() { if(this.isFloatingMenuVisible) { this.closeFloatingMenu(); } }
    handleQuickAlign(event) { const alignVal = event.currentTarget.value; this.updateActiveSheetColumn(this.selectedColumnApiName, { alignment: alignVal }); }
    handleQuickHide() { if (!this.selectedColumnApiName) return; this.updateActiveSheetColumn(this.selectedColumnApiName, { visible: false }); this.closeFloatingMenu(); this.selectedColumnApiName = null; }
    /* Mover columna seleccionada una posición a la izquierda o derecha entre las
       columnas visibles (intercambia .order con su vecina). Afecta panel, tabla
       y exportaciones porque todos leen column.order. */
    _moveSelectedColumn(direction) {
        if (!this.selectedColumnApiName || !this.activeSheet) return;
        const visibles = this.previewColumns;
        const idx = visibles.findIndex(c => c.apiName === this.selectedColumnApiName);
        if (idx === -1) return;
        const swapIdx = direction === 'left' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= visibles.length) return;
        const a = visibles[idx];
        const b = visibles[swapIdx];
        const updatedColumns = (this.activeSheet.columns || []).map(c => {
            if (c.apiName === a.apiName) return { ...c, order: b.order };
            if (c.apiName === b.apiName) return { ...c, order: a.order };
            return c;
        });
        this.updateActiveSheet({ columns: updatedColumns });
    }
    handleMoveColumnLeft()  { this._moveSelectedColumn('left'); }
    handleMoveColumnRight() { this._moveSelectedColumn('right'); }
    get canMoveColumnLeft() {
        if (!this.selectedColumnApiName) return false;
        const visibles = this.previewColumns;
        const idx = visibles.findIndex(c => c.apiName === this.selectedColumnApiName);
        return idx > 0;
    }
    get canMoveColumnRight() {
        if (!this.selectedColumnApiName) return false;
        const visibles = this.previewColumns;
        const idx = visibles.findIndex(c => c.apiName === this.selectedColumnApiName);
        return idx >= 0 && idx < visibles.length - 1;
    }
    get cantMoveColumnLeft()  { return !this.canMoveColumnLeft;  }
    get cantMoveColumnRight() { return !this.canMoveColumnRight; }
    handleSelectedColumnChange(event) { if (!this.selectedColumnApiName) return; const field = event.currentTarget.dataset.field; if (!field) return; let value = event.target.type === 'checkbox' ? event.target.checked : (event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value); if (field === 'width') { value = Number(value) || 120; value = Math.max(70, value); } this.updateActiveSheetColumn(this.selectedColumnApiName, { [field]: value }); }
    
    updateActiveSheet(changes, persistDraft = true) { if (!this.activeSheetId || !this.workbookConfig.sheets) return; const updatedSheets = this.workbookConfig.sheets.map(sheet => { if (sheet.id !== this.activeSheetId) return sheet; return { ...sheet, ...changes }; }); this.workbookConfig = { ...this.workbookConfig, sheets: updatedSheets }; if (persistDraft) this.saveDraftToSession(); }
    updateActiveSheetColumn(apiName, changes, persistDraft = true) { if (!apiName || !this.activeSheetId || !this.workbookConfig.sheets) return; const updatedSheets = this.workbookConfig.sheets.map(sheet => { if (sheet.id !== this.activeSheetId) return sheet; const updatedColumns = sheet.columns.map(column => { if (column.apiName !== apiName) return column; return { ...column, ...changes }; }); return { ...sheet, columns: updatedColumns }; }); this.workbookConfig = { ...this.workbookConfig, sheets: updatedSheets }; if (persistDraft) this.saveDraftToSession(); }

    createBlankFilter(logic = 'AND') {
        return { id: `flt_${Date.now()}_${Math.floor(Math.random() * 10000)}`, logic, filterColumn: '', operator: 'eq', filterValue: '', filterValue2: '' };
    }

    normalizeSheetFilters(rawFilters) {
        const list = Array.isArray(rawFilters?.items) ? rawFilters.items : [];
        let items = list
            .map((f, idx) => ({
                id: f.id || `flt_${Date.now()}_${idx}`,
                logic: f.logic === 'OR' ? 'OR' : 'AND',
                filterColumn: f.filterColumn || '',
                operator: resolveFilterOperator(f),
                filterValue: f.filterValue || '',
                filterValue2: f.filterValue2 || ''
            }));
        // Compatibilidad con formato antiguo {filterColumn, filterValue}: operator implicito 'eq'.
        if (!items.length && rawFilters && (rawFilters.filterColumn || rawFilters.filterValue)) {
            items = [{
                id: `flt_${Date.now()}_legacy`,
                logic: 'AND',
                filterColumn: rawFilters.filterColumn || '',
                operator: 'eq',
                filterValue: rawFilters.filterValue || '',
                filterValue2: ''
            }];
        }
        if (!items.length) items = [this.createBlankFilter()];
        return {
            filterColumn: items[0].filterColumn || '',
            filterValue: items[0].filterValue || '',
            items
        };
    }

    getFilterValueOptionsForColumn(filterColumn) {
        if (!filterColumn || !this.reportDataJson) return [{ label: 'Ninguno / Todos', value: '' }];
        const parsedData = this.getParsedReportData();
        if (!parsedData?.reportMetadata?.detailColumns) return [{ label: 'Ninguno / Todos', value: '' }];
        const colIndex = parsedData.reportMetadata.detailColumns.indexOf(filterColumn);
        if (colIndex === -1) return [{ label: 'Ninguno / Todos', value: '' }];
        const uniqueValues = new Set();
        const rows = parsedData.factMap?.['T!T']?.rows || [];
        rows.forEach((r) => {
            const cell = r.dataCells[colIndex];
            if (!cell) return;
            const v = cell.label ? String(cell.label) : String(cell.value || '');
            uniqueValues.add(v.trim());
        });
        return [{ label: 'Ninguno / Todos', value: '' }, ...Array.from(uniqueValues).sort().map((v) => ({ label: v, value: v }))];
    }

    updateFilterOptions() {
        const first = this.activeSheet?.filters?.items?.[0]?.filterColumn || this.activeSheet?.filters?.filterColumn || '';
        this.dynamicFilterOptions = this.getFilterValueOptionsForColumn(first);
    }

    addSheetFilter() {
        if (!this.activeSheet) return;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const updated = { ...filters, items: [...filters.items, this.createBlankFilter('AND')] };
        this.updateActiveSheet({ filters: updated });
    }

    removeSheetFilter(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        let items = filters.items.filter((f) => f.id !== fid);
        if (!items.length) items = [this.createBlankFilter('AND')];
        const updated = { ...filters, items, filterColumn: items[0].filterColumn || '', filterValue: items[0].filterValue || '' };
        this.updateActiveSheet({ filters: updated });
    }

    handleSheetFilterLogicChange(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        const val = event.detail.value === 'OR' ? 'OR' : 'AND';
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = filters.items.map((f) => (f.id === fid ? { ...f, logic: val } : f));
        const updated = { ...filters, items, filterColumn: items[0].filterColumn || '', filterValue: items[0].filterValue || '' };
        this.updateActiveSheet({ filters: updated });
    }

    handleSheetFilterColumnChange(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        const val = event.detail.value;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = filters.items.map((f) => (f.id === fid ? { ...f, filterColumn: val, filterValue: '' } : f));
        const updated = { ...filters, items, filterColumn: items[0].filterColumn || '', filterValue: items[0].filterValue || '' };
        this.updateActiveSheet({ filters: updated });
        this.updateFilterOptions();
    }

    handleSheetFilterValueChange(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        const val = event.detail.value;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = filters.items.map((f) => (f.id === fid ? { ...f, filterValue: val } : f));
        const updated = { ...filters, items, filterColumn: items[0].filterColumn || '', filterValue: items[0].filterValue || '' };
        this.updateActiveSheet({ filters: updated });
    }

    handleSheetFilterValue2Change(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        const val = event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = filters.items.map((f) => (f.id === fid ? { ...f, filterValue2: val } : f));
        const updated = { ...filters, items };
        this.updateActiveSheet({ filters: updated });
    }

    handleSheetFilterOperatorChange(event) {
        if (!this.activeSheet) return;
        const fid = event.currentTarget.dataset.fid;
        const val = event.detail.value;
        const filters = this.normalizeSheetFilters(this.activeSheet.filters || {});
        const items = filters.items.map((f) => {
            if (f.id !== fid) return f;
            const spec = FILTER_OPERATOR_MAP[val] || FILTER_OPERATOR_MAP.eq;
            /* Si el operador nuevo no necesita valor, limpiamos los valores para que el filtro se evalue limpio. */
            const next = { ...f, operator: val };
            if (!spec.needsValue) {
                next.filterValue = '';
                next.filterValue2 = '';
            }
            if (spec.value !== 'between') next.filterValue2 = '';
            return next;
        });
        const updated = { ...filters, items, filterColumn: items[0].filterColumn || '', filterValue: items[0].filterValue || '' };
        this.updateActiveSheet({ filters: updated });
    }
    handleGlobalFontChange(e) { this.workbookConfig = { ...this.workbookConfig, theme: { ...this.workbookConfig.theme, font: e.detail.value } }; this.saveDraftToSession(); }
    /* ─── Bordes tipo Excel ───
       Settings por hoja: borderStyle ('all'|'horizontal'|'vertical'|'outer'|'none'),
       borderColor (hex), borderWidth (1..3). Se aplican a preview, Excel y PDF. */
    get borderStyleOptions() {
        return [
            { label: 'Todos los bordes', value: 'all' },
            { label: 'Solo horizontales', value: 'horizontal' },
            { label: 'Solo verticales', value: 'vertical' },
            { label: 'Bordes externos', value: 'outer' },
            { label: 'Sin bordes', value: 'none' }
        ];
    }
    get borderStyleValue() {
        const v = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.borderStyle;
        return ['all', 'horizontal', 'vertical', 'outer', 'none'].includes(v) ? v : 'all';
    }
    get borderColorValue() {
        const v = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.borderColor;
        return v && /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? v : '#D8DDE6';
    }
    get borderWidthValue() {
        const n = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.borderWidth;
        const x = Number(n);
        return Number.isFinite(x) && x >= 1 && x <= 3 ? Math.round(x) : 1;
    }
    handleBorderStyleChange(event) {
        if (!this.activeSheet) return;
        const v = event.detail && event.detail.value;
        if (!['all', 'horizontal', 'vertical', 'outer', 'none'].includes(v)) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, borderStyle: v } });
    }
    handleBorderColorChange(event) {
        if (!this.activeSheet) return;
        const v = this._readColorFromEvent(event);
        if (!v) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, borderColor: v } });
    }
    handleBorderWidthChange(event) {
        if (!this.activeSheet) return;
        const raw = (event.detail && event.detail.value !== undefined) ? event.detail.value : event.target.value;
        const n = Math.max(1, Math.min(3, Math.round(Number(raw) || 1)));
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, borderWidth: n } });
    }
    /* Devuelve CSS de bordes para una celda dada, según el modo configurado.
       Se usa en preview (HTML inline style) en buildHeaderStyle / buildDataStyle.
       row==='head' → estamos en el thead; rowIdx/colIdx empiezan en 0; rowIdx==='last'/colIdx==='last'
       NOTA: para preview no diferenciamos primera/última fila salvo 'outer', donde necesitamos saberlo
       en data cells. La función acepta isFirstRow/isLastRow/isFirstCol/isLastCol opcionales. */
    _getPreviewBorderCss(opts) {
        const style = this.borderStyleValue;
        const color = this.borderColorValue;
        const w = `${this.borderWidthValue}px`;
        const line = `${w} solid ${color}`;
        const none = '0';
        if (style === 'none') return 'border:none';
        const { isHead = false, isFirstCol = false, isLastCol = false, isFirstRow = false, isLastRow = false } = opts || {};
        if (style === 'all') return `border:${line}`;
        if (style === 'horizontal') return `border-top:${line};border-bottom:${line};border-left:none;border-right:none`;
        if (style === 'vertical') return `border-left:${line};border-right:${line};border-top:none;border-bottom:none`;
        if (style === 'outer') {
            const top = (isHead || isFirstRow) ? line : none;
            const bottom = isLastRow ? line : (isHead ? line : none);
            const left = isFirstCol ? line : none;
            const right = isLastCol ? line : none;
            /* Si el head no es la última fila pero queremos línea inferior del header → la dejamos para separar header de data. */
            return `border-top:${top};border-bottom:${bottom};border-left:${left};border-right:${right}`;
        }
        return `border:${line}`;
    }
    /* Mapea (borderWidth 1..3) → estilo ExcelJS. */
    _excelLineStyle() {
        const w = this.borderWidthValue;
        if (w >= 3) return 'thick';
        if (w === 2) return 'medium';
        return 'thin';
    }
    /* Devuelve el objeto de borde de ExcelJS para una celda dada, según el modo.
       Reemplaza al antiguo defaultBorder() en celdas de header/data. */
    getCellBorder(opts) {
        const mode = this.borderStyleValue;
        if (mode === 'none') return {};
        const argb = this.toArgb(this.borderColorValue);
        const line = { style: this._excelLineStyle(), color: { argb } };
        const { isHead = false, isFirstCol = false, isLastCol = false, isFirstRow = false, isLastRow = false } = opts || {};
        if (mode === 'all') return { top: line, left: line, bottom: line, right: line };
        if (mode === 'horizontal') return { top: line, bottom: line };
        if (mode === 'vertical') return { left: line, right: line };
        if (mode === 'outer') {
            const out = {};
            if (isHead || isFirstRow) out.top = line;
            if (isLastRow) out.bottom = line;
            if (isFirstCol) out.left = line;
            if (isLastCol) out.right = line;
            /* Línea horizontal entre header y body en modo outer. */
            if (isHead) out.bottom = line;
            return out;
        }
        return { top: line, left: line, bottom: line, right: line };
    }
    /* Configuración de bordes para jspdf-autotable.
       Devuelve un objeto con lineColor y lineWidth listos para meter en `styles`,
       y un `theme` recomendado ('grid'|'plain'|'striped'). */
    getPdfBorderConfig() {
        const mode = this.borderStyleValue;
        const rgb = this._hexToRgbArray(this.borderColorValue) || [216, 221, 230];
        const w = this.borderWidthValue;
        if (mode === 'none') return { theme: 'plain', styles: { lineWidth: 0 } };
        if (mode === 'horizontal') {
            return { theme: 'plain', styles: { lineColor: rgb, lineWidth: { top: w * 0.5, bottom: w * 0.5, left: 0, right: 0 } } };
        }
        if (mode === 'vertical') {
            return { theme: 'plain', styles: { lineColor: rgb, lineWidth: { top: 0, bottom: 0, left: w * 0.5, right: w * 0.5 } } };
        }
        if (mode === 'outer') {
            /* En PDF emulamos 'outer' con theme plain + bordes externos a la tabla; las celdas internas sin bordes.
               No es perfecto en autotable, pero al menos sin rejilla interna. */
            return { theme: 'plain', styles: { lineColor: rgb, lineWidth: 0 } };
        }
        /* 'all' por defecto. */
        return { theme: 'grid', styles: { lineColor: rgb, lineWidth: w * 0.5 } };
    }
    /* Getters de color de cabecera/filas: siempre devuelven un hex válido
       para que <lightning-input type="color"> renderice y reaccione correctamente. */
    get globalHeaderColorValue() {
        const v = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalHeaderColor;
        return v && /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? v : '#0070C0';
    }
    get globalHeaderTextColorValue() {
        const v = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalHeaderTextColor;
        return v && /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? v : '#FFFFFF';
    }
    get globalDataColorValue() {
        const v = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalDataColor;
        return v && /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? v : '#FFFFFF';
    }
    get globalDataTextColorValue() {
        const v = this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalDataTextColor;
        return v && /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? v : '#000000';
    }
    /* Lee el color desde un evento de lightning-input type="color" o input nativo.
       lightning-input emite detail.value; algunos navegadores también exponen target.value.
       Si no es un hex válido, devolvemos null para no pisar el setting con basura. */
    _readColorFromEvent(event) {
        if (!event) return null;
        let val = (event.detail && event.detail.value) || (event.target && event.target.value) || null;
        if (!val) return null;
        val = String(val).trim();
        if (!val.startsWith('#')) val = '#' + val;
        return /^#[0-9A-Fa-f]{6}$/.test(val) ? val.toUpperCase() : null;
    }
    handleGlobalHeaderColorChange(e) {
        if (!this.activeSheet) return;
        const val = this._readColorFromEvent(e);
        if (!val) return;
        const cols = this.activeSheet.columns.map(c => ({ ...c, headerColor: '' }));
        this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), globalHeaderColor: val }, columns: cols });
    }
    handleGlobalHeaderTextColorChange(e) {
        if (!this.activeSheet) return;
        const val = this._readColorFromEvent(e);
        if (!val) return;
        const cols = this.activeSheet.columns.map(c => ({ ...c, headerTextColor: '' }));
        this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), globalHeaderTextColor: val }, columns: cols });
    }
    handleGlobalDataColorChange(e) {
        if (!this.activeSheet) return;
        const val = this._readColorFromEvent(e);
        if (!val) return;
        const cols = this.activeSheet.columns.map(c => ({ ...c, dataColor: '' }));
        this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), globalDataColor: val }, columns: cols });
    }
    handleGlobalDataTextColorChange(e) {
        if (!this.activeSheet) return;
        const val = this._readColorFromEvent(e);
        if (!val) return;
        const cols = this.activeSheet.columns.map(c => ({ ...c, textColor: '' }));
        this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), globalDataTextColor: val }, columns: cols });
    }
    handleHeaderHeightChange(event) { const value = Number(event.target.value) || 28; this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), headerHeight: value } }); }
    handleDataRowHeightChange(event) { const value = Number(event.target.value) || 24; this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), dataRowHeight: value } }); }
    handleTableStartRowChange(event) { const value = Number(event.target.value) || 1; this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), tableStartRow: Math.max(1, value) } }); }
    handleLogoUpload(event) {
        const file = event.target.files && event.target.files[0];
        if (event.target) event.target.value = '';
        if (!file || !this.activeSheet) return;
        this.normalizeUploadedLogoFile(file).then(dataUrl => {
            this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), logoBase64: dataUrl } });
            void this.persistLogoToIndexedDb(this.selectedReportId, this.activeSheet.id, dataUrl);
            this.showToast('Éxito', 'Logo listo para vista previa y exportación (PNG optimizado).', 'success');
        }).catch(e => {
            this.showToast('Logo', (e && e.message) ? e.message : 'No se pudo procesar la imagen.', 'warning');
        });
    }

    normalizeUploadedLogoFile(file) {
        if (!file.type || !file.type.startsWith('image/')) {
            return Promise.reject(new Error('Selecciona un archivo de imagen (PNG, JPEG, WebP o GIF).'));
        }
        if (file.size > ReporteKaufmann.LOGO_MAX_FILE_BYTES) {
            return Promise.reject(new Error('La imagen supera el tamaño máximo (~1,8 MB). Comprímela e inténtalo de nuevo.'));
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                const img = new Image();
                img.onload = () => {
                    try {
                        let { width, height } = img;
                        if (width < 1 || height < 1) {
                            reject(new Error('Imagen inválida o vacía.'));
                            return;
                        }
                        const maxD = ReporteKaufmann.LOGO_MAX_PX;
                        if (width > maxD || height > maxD) {
                            const s = Math.min(maxD / width, maxD / height);
                            width = Math.round(width * s);
                            height = Math.round(height * s);
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        canvas.toBlob(blob => {
                            if (!blob) {
                                reject(new Error('No se pudo normalizar la imagen (prueba con PNG o JPEG).'));
                                return;
                            }
                            const r2 = new FileReader();
                            r2.onload = () => resolve(r2.result);
                            r2.onerror = () => reject(new Error('Error leyendo la imagen procesada.'));
                            r2.readAsDataURL(blob);
                        }, 'image/png', 0.92);
                    } catch (err) {
                        reject(err);
                    }
                };
                img.onerror = () => reject(new Error('No se pudo leer la imagen. Usa PNG, JPEG, GIF o WebP.'));
                img.src = dataUrl;
            };
            reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            reader.readAsDataURL(file);
        });
    }
    
    async removeLogo(event) {
        event.stopPropagation();
        const ok = await LightningConfirm.open({
            message: '¿Quitar el logo de esta hoja?',
            variant: 'header',
            label: 'Quitar logo',
            theme: 'warning'
        });
        if (!ok) return;
        const sid = this.activeSheet && this.activeSheet.id;
        /* Limpiamos también logoX/logoY/logoHeight para que getEffectiveExcelTableStartRow
           no siga reservando filas vacías arriba en Excel/PDF. Mantenemos defaults
           de logoWidth/logoHeight a sus valores iniciales por si vuelven a cargar logo. */
        this.updateActiveSheet({
            settings: {
                ...(this.activeSheet.settings || {}),
                logoBase64: null,
                logoX: null,
                logoY: null,
                logoCol: 'A',
                logoRow: 1,
                logoWidth: 140,
                logoHeight: 45
            }
        });
        if (this.selectedReportId && sid) void this.deleteLogoFromIndexedDb(this.selectedReportId, sid);
        this.showToast('Logo eliminado', 'El logo se quitó de la hoja.', 'info');
    }
    handleLogoColChange(event) { let val = (event.target.value || 'A').toUpperCase().replace(/[^A-Z]/g, ''); if(!val) val = 'A'; this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), logoCol: val.substring(0, 1) } }); }
    handleLogoRowChange(event) { this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), logoRow: Math.max(1, Number(event.target.value) || 1) } }); }
    handleLogoWidthChange(event) { this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), logoWidth: Math.max(10, Number(event.target.value) || 140) } }); }
    handleLogoHeightChange(event) { this.updateActiveSheet({ settings: { ...(this.activeSheet.settings || {}), logoHeight: Math.max(10, Number(event.target.value) || 45) } }); }

    // NUEVOS MANEJADORES DE ORDEN Y TOTALES
    handleSortByChange(event) { this.updateActiveSheet({ settings: { ...this.activeSheet.settings, sortBy: event.detail.value } }); }
    handleSortDirChange(event) { this.updateActiveSheet({ settings: { ...this.activeSheet.settings, sortDirection: event.detail.value } }); }
    handleShowTotalsChange(event) { this.updateActiveSheet({ settings: { ...this.activeSheet.settings, showTotals: event.target.checked } }); }
    /* Toggle "Ver conteo de registros": muestra el nº total de filas (tras filtros)
       como chip en el breadcrumb del lienzo. No afecta a la exportación Excel/PDF/PPT. */
    handleShowRowCountChange(event) { this.updateActiveSheet({ settings: { ...this.activeSheet.settings, showRowCount: event.target.checked } }); }

    handleBlankHyphenAsEmptyChange(event) {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, blankHyphenAsEmpty: event.target.checked } });
    }

    handleExcelLikePreviewChange(event) {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, excelLikePreview: event.target.checked } });
    }

    /* X2: banding rows (filas alternadas) — toggle + color. */
    handleBandedRowsChange(event) {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, bandedRows: event.target.checked } });
    }
    handleBandedRowColorChange(event) {
        if (!this.activeSheet) return;
        const v = this._readColorFromEvent(event);
        if (!v) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, bandedRowColor: v } });
    }
    get bandedRowsChecked() { return !!(this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.bandedRows); }
    get bandedRowColorValue() { return (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.bandedRowColor) || '#F8FAFC'; }

    handlePreviewFontScaleChange(event) {
        if (!this.activeSheet) return;
        const next = ['compact', 'large', 'standard'].includes(event.detail.value) ? event.detail.value : 'standard';
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, previewFontScale: next } });
    }

    handlePreviewCellWrapWordsChange(event) {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, previewCellWrapWords: event.target.checked } });
    }

    handleAddSubTable() { 
        const newSub = { 
            id: `sub_${Date.now()}_${Math.floor(Math.random() * 1000)}`, title: '', font: 'Calibri', autoFit: true, manualWidth: 400,
            groupByField: '', operation: 'COUNT', metricField: '', orientation: 'vertical', 
            sortBy: 'LABEL', sortDirection: 'ASC',
            headerColor: '#263B7A', headerTextColor: '#FFFFFF', dataColor: '#FFFFFF', dataTextColor: '#000000' 
        }; 
        const currentSubs = this.activeSheet.subTables || []; 
        this.updateActiveSheet({ subTables: [...currentSubs, newSub] }); 
    }
    async handleRemoveSubTable(event) {
        const subId = event.currentTarget.dataset.id;
        if (!subId) return;
        const ok = await LightningConfirm.open({
            message: '¿Eliminar esta tabla pivot de la hoja?',
            variant: 'header',
            label: 'Eliminar pivot',
            theme: 'warning'
        });
        if (!ok) return;
        const filteredSubs = (this.activeSheet.subTables || []).filter((s) => s.id !== subId);
        this.updateActiveSheet({ subTables: filteredSubs });
    }
    handleSubTableChange(event) {
        const subId = event.currentTarget.dataset.id;
        const field = event.currentTarget.dataset.field;
        let value = event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
        if (field === 'excelStartRow') {
            const n = value === '' || value === null || value === undefined ? undefined : Math.max(1, Math.floor(Number(value)));
            const updatedSubs = (this.activeSheet.subTables || []).map((s) => {
                if (s.id !== subId) return s;
                if (n === undefined) {
                    const { excelStartRow, ...rest } = s;
                    return rest;
                }
                return { ...s, excelStartRow: n };
            });
            this.updateActiveSheet({ subTables: updatedSubs });
            return;
        }
        const updatedSubs = (this.activeSheet.subTables || []).map((s) => (s.id === subId ? { ...s, [field]: value } : s));
        this.updateActiveSheet({ subTables: updatedSubs });
    }
    handleSubTableChangeToggle(event) { const subId = event.currentTarget.dataset.id; const field = event.currentTarget.dataset.field; const updatedSubs = (this.activeSheet.subTables || []).map(s => { if (s.id === subId) return { ...s, [field]: event.target.checked }; return s; }); this.updateActiveSheet({ subTables: updatedSubs }); }
    handleSubTableChangeSlider(event) { const subId = event.currentTarget.dataset.id; const field = event.currentTarget.dataset.field; const updatedSubs = (this.activeSheet.subTables || []).map(s => { if (s.id === subId) return { ...s, [field]: Number(event.target.value) }; return s; }); this.updateActiveSheet({ subTables: updatedSubs }); }

    toggleColumnVisibility(event) {
        const apiName = event.currentTarget.dataset.apiName;
        if (!apiName || !this.activeSheet) return;
        const currentColumn = this.activeSheet.columns.find(column => column.apiName === apiName);
        if (!currentColumn) return;
        this.updateActiveSheetColumn(apiName, { visible: !currentColumn.visible });
        this.selectedColumnApiName = apiName;
    }

    handleFieldDragStart(event) { this.draggedApiName = event.currentTarget.dataset.apiName; this.draggedSource = 'panel'; event.dataTransfer.effectAllowed = 'copyMove'; this.closeFloatingMenu(); }

    /* Drag-reorder dentro del panel izquierdo. Al soltar reasignamos column.order
       de TODAS las columnas en activeSheet.columns, de modo que el cambio se vea
       de inmediato en:
         - El panel izquierdo (orderedBaseColumns lee column.order).
         - La vista previa central (previewColumns ordena por order).
         - El Excel y el PPT (buildDetailSheet usa el mismo column.order).
       Si el drag se suelta fuera del panel, gana el handler correspondiente
       (handleCanvasDrop activa columna, handlePanelDrop oculta columna). */
    handleFieldReorderDragOver(event) {
        if (this.draggedSource !== 'panel' || !this.draggedApiName) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const targetApiName = event.currentTarget.dataset.apiName;
        if (!targetApiName || targetApiName === this.draggedApiName) {
            if (this.dragOverPanelApiName) {
                this.dragOverPanelApiName = null;
                this.dragOverPanelPosition = null;
            }
            return;
        }
        /* Detectamos si el cursor está en la mitad superior o inferior del item
           para mostrar el indicador de inserción correcto y para insertar el
           campo en la posición exacta deseada. */
        const rect = event.currentTarget.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const pos = event.clientY < midpoint ? 'before' : 'after';
        if (this.dragOverPanelApiName !== targetApiName || this.dragOverPanelPosition !== pos) {
            this.dragOverPanelApiName = targetApiName;
            this.dragOverPanelPosition = pos;
        }
    }
    handleFieldReorderDragLeave(event) {
        const targetApiName = event.currentTarget.dataset.apiName;
        if (targetApiName === this.dragOverPanelApiName) {
            this.dragOverPanelApiName = null;
            this.dragOverPanelPosition = null;
        }
    }
    handleFieldReorderDrop(event) {
        if (this.draggedSource !== 'panel' || !this.draggedApiName) return;
        event.preventDefault();
        event.stopPropagation();
        const targetApiName = event.currentTarget.dataset.apiName;
        const sourceApiName = this.draggedApiName;
        const pos = this.dragOverPanelPosition || 'before';
        this.dragOverPanelApiName = null;
        this.dragOverPanelPosition = null;
        this.draggedApiName = null;
        this.draggedSource = null;
        if (!targetApiName || !sourceApiName || targetApiName === sourceApiName || !this.activeSheet) return;

        /* 1. Calculamos el nuevo orden visual del panel (apiNames) tomando como
              base orderedBaseColumns (que ya respeta column.order actual). */
        const apiList = this.orderedBaseColumns.map(c => c.apiName);
        const fromIdx = apiList.indexOf(sourceApiName);
        if (fromIdx === -1) return;
        apiList.splice(fromIdx, 1);
        let toIdx = apiList.indexOf(targetApiName);
        if (toIdx === -1) return;
        if (pos === 'after') toIdx += 1;
        apiList.splice(toIdx, 0, sourceApiName);

        /* 2. Reasignamos column.order = 1..N en activeSheet.columns según apiList.
              Las columnas que no aparezcan en apiList (caso raro) reciben order
              consecutivo a partir de N+1 para mantener integridad. */
        const newOrderMap = new Map();
        apiList.forEach((apiName, idx) => newOrderMap.set(apiName, idx + 1));
        let nextOther = apiList.length + 1;
        const updatedColumns = (this.activeSheet.columns || []).map(c => {
            if (newOrderMap.has(c.apiName)) return { ...c, order: newOrderMap.get(c.apiName) };
            const o = nextOther; nextOther += 1;
            return { ...c, order: o };
        });
        this.updateActiveSheet({ columns: updatedColumns });
    }
    /* ─── B2: drag-and-drop para reordenar las pestañas de hojas ──────────
       Misma idea que el drag-reorder del panel izquierdo: detectamos si el
       cursor está antes o después del centro del wrap para decidir dónde
       insertar la hoja al soltar. Se reescribe workbookConfig.sheets en el
       nuevo orden y el activo se mantiene. */
    handleSheetDragStart(event) {
        const sheetId = event.currentTarget.dataset.sheetId;
        if (!sheetId) return;
        this.draggedSheetId = sheetId;
        try {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', sheetId);
        } catch (_e) { /* no-op: algunos browsers viejos */ }
    }
    handleSheetDragOver(event) {
        if (!this.draggedSheetId) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const targetId = event.currentTarget.dataset.sheetId;
        if (!targetId || targetId === this.draggedSheetId) {
            if (this.dragOverSheetId) {
                this.dragOverSheetId = null;
                this.dragOverSheetPosition = null;
            }
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const pos = event.clientX < midpoint ? 'before' : 'after';
        if (this.dragOverSheetId !== targetId || this.dragOverSheetPosition !== pos) {
            this.dragOverSheetId = targetId;
            this.dragOverSheetPosition = pos;
        }
    }
    handleSheetDragLeave(event) {
        const targetId = event.currentTarget.dataset.sheetId;
        if (targetId === this.dragOverSheetId) {
            this.dragOverSheetId = null;
            this.dragOverSheetPosition = null;
        }
    }
    handleSheetDragEnd() {
        this.draggedSheetId = null;
        this.dragOverSheetId = null;
        this.dragOverSheetPosition = null;
    }
    handleSheetDrop(event) {
        if (!this.draggedSheetId) return;
        event.preventDefault();
        event.stopPropagation();
        const targetId = event.currentTarget.dataset.sheetId;
        const sourceId = this.draggedSheetId;
        const pos = this.dragOverSheetPosition || 'before';
        this.draggedSheetId = null;
        this.dragOverSheetId = null;
        this.dragOverSheetPosition = null;
        if (!targetId || !sourceId || targetId === sourceId) return;

        const sheets = [...(this.workbookConfig.sheets || [])];
        const fromIdx = sheets.findIndex(s => s.id === sourceId);
        if (fromIdx === -1) return;
        const [moved] = sheets.splice(fromIdx, 1);
        let toIdx = sheets.findIndex(s => s.id === targetId);
        if (toIdx === -1) return;
        if (pos === 'after') toIdx += 1;
        sheets.splice(toIdx, 0, moved);
        this.workbookConfig = { ...this.workbookConfig, sheets };
        this.saveDraftToSession();
    }

    handleColumnDragStart(event) { this.draggedApiName = event.currentTarget.dataset.apiName; this.draggedSource = 'header'; event.dataTransfer.effectAllowed = 'move'; this.closeFloatingMenu(); }
    handleColumnDragOver(event) { event.preventDefault(); event.dataTransfer.dropEffect = this.draggedSource === 'panel' ? 'copy' : 'move'; }

    handleColumnDrop(event) {
        event.preventDefault(); event.stopPropagation(); 
        const targetApiName = event.currentTarget.dataset.apiName; const sourceApiName = this.draggedApiName;
        if (!sourceApiName || !targetApiName || !this.activeSheet) return;
        let updatedColumns = [...this.activeSheet.columns];

        if (this.draggedSource === 'panel') {
            const colIndex = updatedColumns.findIndex(c => c.apiName === sourceApiName);
            if (colIndex !== -1) updatedColumns[colIndex] = { ...updatedColumns[colIndex], visible: true };
        }

        let visibleColumns = updatedColumns.filter(c => c.visible).sort((a, b) => a.order - b.order);
        const sourceIdx = visibleColumns.findIndex(c => c.apiName === sourceApiName);
        const targetIdx = visibleColumns.findIndex(c => c.apiName === targetApiName);

        if (sourceIdx !== -1 && targetIdx !== -1 && sourceIdx !== targetIdx) {
            const [moved] = visibleColumns.splice(sourceIdx, 1);
            visibleColumns.splice(targetIdx, 0, moved);
        }

        const orderMap = {}; visibleColumns.forEach((col, idx) => { orderMap[col.apiName] = idx + 1; });
        let nextHiddenOrder = visibleColumns.length + 1;
        updatedColumns = updatedColumns.map(col => {
            if (orderMap[col.apiName]) return { ...col, order: orderMap[col.apiName] };
            const assigned = nextHiddenOrder; nextHiddenOrder += 1; return { ...col, order: assigned };
        });

        this.updateActiveSheet({ columns: updatedColumns });
        this.selectedColumnApiName = sourceApiName;
        this.draggedApiName = null; this.draggedSource = null;
    }

    handleCanvasDrop(event) { event.preventDefault(); if (this.draggedSource === 'panel' && this.draggedApiName) { this.updateActiveSheetColumn(this.draggedApiName, { visible: true }); this.selectedColumnApiName = this.draggedApiName; } this.draggedApiName = null; this.draggedSource = null; }
    handlePanelDrop(event) { event.preventDefault(); if (this.draggedSource === 'header' && this.draggedApiName) { this.updateActiveSheetColumn(this.draggedApiName, { visible: false }); if (this.selectedColumnApiName === this.draggedApiName) { this.selectedColumnApiName = null; this.closeFloatingMenu(); } } this.draggedApiName = null; this.draggedSource = null; }
    startColumnResize(event) { event.preventDefault(); event.stopPropagation(); const apiName = event.currentTarget.dataset.apiName; if (!apiName || !this.activeSheet) return; const col = this.activeSheet.columns.find(c => c.apiName === apiName); if (!col) return; this.resizingColumnApiName = apiName; this.resizeStartX = event.clientX; this.resizeStartWidth = col.width || 120; window.addEventListener('mousemove', this.handleColumnResizeMove); window.addEventListener('mouseup', this.stopColumnResize); this.closeFloatingMenu(); }
    handleColumnResizeMove = (event) => { if (!this.resizingColumnApiName) return; const delta = event.clientX - this.resizeStartX; const newWidth = Math.max(70, (this.resizeStartWidth || 120) + delta); this.updateActiveSheetColumn(this.resizingColumnApiName, { width: newWidth }, false); };
    stopColumnResize = () => { if (this.resizingColumnApiName) this.saveDraftToSession(); window.removeEventListener('mousemove', this.handleColumnResizeMove); window.removeEventListener('mouseup', this.stopColumnResize); this.resizingColumnApiName = null; };
    startHeaderResize(event) { event.preventDefault(); event.stopPropagation(); this.resizingHeader = true; this.resizeStartY = event.clientY; this.resizeStartHeight = this.activeSheet.settings.headerHeight || 28; window.addEventListener('mousemove', this.handleHeaderResizeMove); window.addEventListener('mouseup', this.stopHeaderResize); this.closeFloatingMenu(); }
    handleHeaderResizeMove = (event) => { if (!this.resizingHeader) return; const delta = event.clientY - this.resizeStartY; const newH = Math.max(15, this.resizeStartHeight + delta); this.updateActiveSheet({ settings: { ...this.activeSheet.settings, headerHeight: newH } }, false); };
    stopHeaderResize = () => { if (this.resizingHeader) this.saveDraftToSession(); window.removeEventListener('mousemove', this.handleHeaderResizeMove); window.removeEventListener('mouseup', this.stopHeaderResize); this.resizingHeader = false; };
    startRowResize(event) { event.preventDefault(); event.stopPropagation(); this.resizingRow = true; this.resizeStartY = event.clientY; this.resizeStartHeight = this.activeSheet.settings.dataRowHeight || 24; window.addEventListener('mousemove', this.handleRowResizeMove); window.addEventListener('mouseup', this.stopRowResize); }
    handleRowResizeMove = (event) => { if (!this.resizingRow) return; const delta = event.clientY - this.resizeStartY; const newH = Math.max(15, this.resizeStartHeight + delta); this.updateActiveSheet({ settings: { ...this.activeSheet.settings, dataRowHeight: newH } }, false); };
    stopRowResize = () => { if (this.resizingRow) this.saveDraftToSession(); window.removeEventListener('mousemove', this.handleRowResizeMove); window.removeEventListener('mouseup', this.stopRowResize); this.resizingRow = false; };

    async updateProgress(progress, text) {
        this.exportProgress = progress;
        this.exportStatusText = text;
        await new Promise(resolve => setTimeout(resolve, 50)); 
    }

    buildHeaderStyle(col, index = 0, totalCols = 1) {
        const width = col.width || 120;
        const height = (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.headerHeight) ? this.activeSheet.settings.headerHeight : 28;
        const bgColor = col.headerColor || (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalHeaderColor) || '#0070C0';
        const textColor = col.headerTextColor || (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalHeaderTextColor) || '#FFFFFF';
        const borderCss = this._getPreviewBorderCss({ isHead: true, isFirstCol: index === 0, isLastCol: index === totalCols - 1, isFirstRow: true, isLastRow: false });
        return [ `width:${width}px`, `min-width:${width}px`, `height:${height}px`, `background:${bgColor}`, `color:${textColor}`, `font-family:${this.formatThemeFontCss(this.getWorkbookFont())}`, 'font-weight:bold', 'padding:8px', borderCss, 'text-align:center', 'position:relative', 'white-space:nowrap', 'user-select:none' ].join(';');
    }
    getEffectiveDataHorizontalAlign(col) {
        const user = (col && col.alignment) ? col.alignment : 'left';
        if (user !== 'left') return user;
        const fmt = (col.format || 'auto').toLowerCase();
        const dt = ((col.dataType || '')).toUpperCase();
        if (['number', 'currency', 'percent'].includes(fmt)) return 'right';
        if (['DOUBLE', 'INT', 'CURRENCY', 'PERCENT'].includes(dt)) return 'right';
        return 'left';
    }
    buildDataStyle(col, index = 0, totalCols = 1) {
        const width = col.width || 120;
        const align = this.getEffectiveDataHorizontalAlign(col);
        const bgColor = col.dataColor || (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalDataColor) || '#FFFFFF';
        const txtColor = col.textColor || (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.globalDataTextColor) || '#000000';
        const wrap = this.activeSheet?.settings?.previewCellWrapWords;
        const whiteSpace = wrap ? 'normal' : 'nowrap';
        const overflow = wrap ? 'visible' : 'hidden';
        const textOverflow = wrap ? 'clip' : 'ellipsis';
        /* No conocemos primera/última fila aquí: en modo 'outer' las laterales aparecen y top/bottom no.
           Aceptable visualmente: el header ya aporta la línea superior y el último td aporta la inferior natural. */
        const borderCss = this._getPreviewBorderCss({ isHead: false, isFirstCol: index === 0, isLastCol: index === totalCols - 1, isFirstRow: false, isLastRow: false });
        return [`width:${width}px`, `min-width:${width}px`, `background:${bgColor}`, `color:${txtColor}`, `font-family:${this.formatThemeFontCss(this.getWorkbookFont())}`, 'padding:7px 8px', borderCss, `text-align:${align}`, `white-space:${whiteSpace}`, `overflow:${overflow}`, `text-overflow:${textOverflow}`, 'position:relative', wrap ? 'word-break:break-word' : '', 'vertical-align:top'].filter(Boolean).join(';');
    }
    
    handleExportMenuSelect(event) {
        const selectedFormat = event.detail.value;
        if (selectedFormat === 'excel')         { this.generarExcelLocal(); }
        else if (selectedFormat === 'pdf')      { this.generarPdfLocal(); }
        else if (selectedFormat === 'config_export') { this.exportReportConfigToFile(); }
        else if (selectedFormat === 'config_import') { this.triggerImportReportConfigDialog(); }
    }
    validateActiveSheetForExport() {
        if (!this.activeSheet) return { valid: false, message: 'No hay hoja activa para exportar.' };
        if (this.isTableSheet && this.visibleColumnsCount === 0) return { valid: false, message: 'La hoja no tiene columnas visibles. Activa al menos una columna.' };
        if (this.isSummarySheet && this.invalidPivotCount > 0) return { valid: false, message: 'Hay tablas Pivot incompletas. Revisa "Agrupar por" y "Campo a Calcular".' };
        return { valid: true, message: '' };
    }

    /** Valida cada hoja del libro (Excel exporta todas). Devuelve lista de problemas por hoja. */
    validateAllSheetsForExport() {
        const sheets = this.workbookConfig?.sheets || [];
        if (!sheets.length) return { valid: false, issues: [{ sheet: '(libro)', message: 'No hay hojas configuradas.' }] };
        const issues = [];
        sheets.forEach(sheet => {
            const isTable = sheet.type === 'detail';
            const isSummary = sheet.type === 'summary';
            const visibleCols = (sheet.columns || []).filter(c => c.visible).length;
            if (isTable && visibleCols === 0) {
                issues.push({ sheet: sheet.name || sheet.id, message: 'No tiene columnas visibles.' });
            }
            if (isSummary) {
                const invalidPivots = (sheet.subTables || []).filter(sub => {
                    if (!sub.groupByField) return true;
                    if ((sub.operation === 'SUM' || sub.operation === 'AVG') && !sub.metricField) return true;
                    return false;
                }).length;
                if (invalidPivots > 0) {
                    issues.push({ sheet: sheet.name || sheet.id, message: `${invalidPivots} pivot(s) incompleto(s).` });
                }
                if (!(sheet.subTables || []).length) {
                    issues.push({ sheet: sheet.name || sheet.id, message: 'Hoja resumen sin tablas pivot.' });
                }
            }
        });
        return { valid: issues.length === 0, issues };
    }

    async generarPdfLocal() {
        if (!this.pdfJsLoaded || !window.jspdf) { this.showToast('Validación', 'Librería jsPDF no cargada.', 'warning'); return; }
        if (!this.reportDataJson || !this.activeSheet) { this.showToast('Validación', 'No hay datos para exportar.', 'warning'); return; }
        const exportValidation = this.validateActiveSheetForExport();
        if (!exportValidation.valid) { this.showToast('Validación', exportValidation.message, 'warning'); return; }
        
        this.isExporting = true;
        await this.updateProgress(10, 'Iniciando conversión a PDF...');
        
        try {
            const sheet = this.activeSheet; const parsedData = this.getParsedReportData();
            if (!parsedData) { this.showToast('Validación', 'No hay datos del reporte para exportar.', 'warning'); return; }
            /* X7: orientación y márgenes configurables. effectivePdfOrientation se
               calcula auto/portrait/landscape; effectivePdfMargin retorna pt. */
            const pdfOrient = this.effectivePdfOrientation || 'landscape';
            const pdfMarginPt = this.effectivePdfMargin || 20;
            const doc = new window.jspdf.jsPDF({ orientation: pdfOrient, unit: 'pt', format: 'a4' });
            const marginX = pdfMarginPt; const availablePageWidth = doc.internal.pageSize.width - (marginX * 2); let currentY = Math.max(20, pdfMarginPt - 10);
            
            await this.updateProgress(40, 'Aplicando estilos visuales...');

            if (sheet.settings && sheet.settings.logoBase64) {
                try {
                    const sLogo = sheet.settings;
                    /* Y5: si logoX/logoY existen (drag libre), usamos esa posición en px
                       convertida a pt (factor 0.75 = 1/1.333). De lo contrario, mantenemos
                       el cálculo legacy basado en logoCol. El logoW/logoH siempre
                       respetan el tamaño definido por el usuario tras el resize. */
                    const logoW = (sLogo.logoWidth  || 140) * 0.75;
                    const logoH = (sLogo.logoHeight || 45)  * 0.75;
                    let logoMarginX, logoMarginY;
                    if (sLogo.logoX != null || sLogo.logoY != null) {
                        logoMarginX = marginX + (Number(sLogo.logoX) || 0) * 0.75;
                        logoMarginY = (Math.max(20, pdfMarginPt - 10)) + (Number(sLogo.logoY) || 0) * 0.75;
                    } else {
                        const colLetter = (sLogo.logoCol || 'A').toUpperCase();
                        let colIndex = colLetter.charCodeAt(0) - 65; if (colIndex < 0) colIndex = 0;
                        logoMarginX = marginX;
                        logoMarginY = currentY - 15;
                        const visibleColumns = (sheet.columns || []).filter(c => c.visible).sort((a, b) => a.order - b.order);
                        if (colIndex > 0 && visibleColumns.length > 0) {
                            const totalUIWidth = visibleColumns.reduce((acc, col) => acc + (col.width || 120), 0);
                            let previousColsWidth = 0;
                            for (let i = 0; i < colIndex && i < visibleColumns.length; i++) previousColsWidth += (visibleColumns[i].width || 120);
                            logoMarginX = marginX + (availablePageWidth * (previousColsWidth / totalUIWidth));
                        }
                    }
                    const imgType = getJsPdfImageFormat(sLogo.logoBase64);
                    doc.addImage(sLogo.logoBase64, imgType, logoMarginX, logoMarginY, logoW, logoH);
                    /* No avanzamos currentY aquí: el espacio bajo el logo se controla
                       a través de getEffectiveExcelTableStartRow (que calcula filas
                       basándose en logoY + logoHeight). Esto evita doble desplazamiento. */
                } catch (logoPdfErr) {
                    console.warn('PDF: logo omitido', logoPdfErr);
                }
            }
            
            const rowPx = Number(sheet.settings.dataRowHeight) || 24;
            const effTableStart = getEffectiveExcelTableStartRow(sheet);
            currentY += Math.max(0, effTableStart - 1) * rowPx * 0.72;
            
            if (sheet.type === 'detail') {
                const visibleColumns = (sheet.columns || []).filter(c => c.visible).sort((a, b) => a.order - b.order);
                const tableHeaders = visibleColumns.map(c => c.alias || c.label); 
                const rows = getRowsForSheet(sheet, parsedData);
                const tableBody = rows.map(r => { return visibleColumns.map(col => { 
                    const cIdx = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns.indexOf(col.apiName) : -1; 
                    let dataType = col.dataType;
                    if (parsedData.reportExtendedMetadata && parsedData.reportExtendedMetadata.detailColumnInfo && parsedData.reportExtendedMetadata.detailColumnInfo[col.apiName]) {
                        dataType = parsedData.reportExtendedMetadata.detailColumnInfo[col.apiName].dataType;
                    }
                    const cellData = col.isVirtual ? computeVirtualCellValue(r, col, parsedData) : (cIdx >= 0 ? r.dataCells[cIdx] : null); 
                    let v = this.getExcelValue(cellData, dataType, col.format, sheet);
                    /* PDF no tiene numFmt: si es Date, lo convertimos a string respetando dateFormat por columna. */
                    if (v instanceof Date) v = this._formatDateForPreview(v, col.dateFormat || 'auto', dataType);
                    return v;
                }); });
                
                // MEJORA 3: FILA DE TOTALES EN PDF
                if (sheet.settings.showTotals) {
                    let totalsArr = visibleColumns.map((col, index) => {
                        if(index === 0) return 'Total General';
                        let isNumeric = ['DOUBLE', 'INT', 'CURRENCY', 'PERCENT'].includes((col.dataType||'').toUpperCase()) || col.format === 'number' || col.format === 'currency';
                        if(!isNumeric) return '';
                        let sum = rows.reduce((acc, row) => {
                            const cIdx = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns.indexOf(col.apiName) : -1;
                            const cellData = col.isVirtual ? computeVirtualCellValue(row, col, parsedData) : (cIdx >= 0 ? row.dataCells[cIdx] : null);
                            return acc + (Number(cellData?.value) || 0);
                        }, 0);
                        return this.getExcelValue({ value: sum, label: sum }, col.dataType, col.format, sheet);
                    });
                    tableBody.push(totalsArr);
                }

                const fontName = this.resolvePdfBuiltinFont(this.workbookConfig.theme.font);

                let colCount = visibleColumns.length;
                let dynamicHeaderFontSize = colCount > 8 ? (colCount > 12 ? 6 : 8) : 10;
                let dynamicDataFontSize = colCount > 8 ? (colCount > 12 ? 6 : 8) : 9;
                /* X5: ajuste de densidad — compact resta 1pt, large suma 1pt. */
                const densityScale = (sheet.settings && sheet.settings.previewFontScale) || 'standard';
                if (densityScale === 'compact') { dynamicHeaderFontSize = Math.max(5, dynamicHeaderFontSize - 1); dynamicDataFontSize = Math.max(5, dynamicDataFontSize - 1); }
                else if (densityScale === 'large') { dynamicHeaderFontSize += 2; dynamicDataFontSize += 2; }
                /* X3: padding más generoso (parecido al preview que usa 7-8px). */
                let dynamicPadding = colCount > 12 ? { top: 3, right: 4, bottom: 3, left: 4 }
                                  : colCount > 8  ? { top: 4, right: 5, bottom: 4, left: 5 }
                                  :                 { top: 5, right: 7, bottom: 5, left: 7 };

                const pdfStyles = this.buildPdfColumnStyles(visibleColumns, availablePageWidth, tableBody, sheet.settings);

                /* U2: si 'Ajustar texto' está apagado, el PDF muestra elipsis en
                   lugar de saltar de línea (coherente con el preview HTML que usa
                   text-overflow: ellipsis). */
                const pdfWrap = !!(sheet.settings && sheet.settings.previewCellWrapWords);
                /* X2: banding rows en PDF (alternateRowStyles).
                   Convertimos el hex a [r,g,b] que requiere jspdf-autotable. */
                const bandedActivePdf = !!(sheet.settings && sheet.settings.bandedRows);
                const bandedHexPdf    = (sheet.settings && sheet.settings.bandedRowColor) || '#F8FAFC';
                const bandedRgbPdf    = bandedActivePdf ? this._hexToRgbArray(bandedHexPdf) : null;
                /* X8: configuración de bordes (color, grosor, modo) — se mezcla con el resto de styles. */
                const borderCfg = this.getPdfBorderConfig();
                const mergedStyles = { font: fontName, fontSize: dynamicDataFontSize, cellPadding: dynamicPadding, valign: pdfWrap ? 'top' : 'middle', overflow: pdfWrap ? 'linebreak' : 'ellipsize', ...(borderCfg.styles || {}) };
                doc.autoTable({ 
                    startY: currentY, 
                    head: [tableHeaders], 
                    body: tableBody, 
                    theme: borderCfg.theme || 'grid', 
                    styles: mergedStyles, 
                    headStyles: { fontStyle: 'bold', halign: 'center', fontSize: dynamicHeaderFontSize }, 
                    alternateRowStyles: bandedRgbPdf ? { fillColor: bandedRgbPdf } : undefined,
                    columnStyles: pdfStyles, 
                    margin: { left: marginX, right: marginX }, 
                    tableWidth: 'auto',
                    didParseCell: (data) => {
                        const ix = data.column.index;
                        const col = visibleColumns[ix];
                        if (data.section === 'head' && col) {
                            const hc = col.headerColor || sheet.settings.globalHeaderColor || '#0070C0';
                            const htc = col.headerTextColor || sheet.settings.globalHeaderTextColor || '#FFFFFF';
                            data.cell.styles.fillColor = this.hexToRgb(hc);
                            data.cell.styles.textColor = this.hexToRgb(htc);
                        }
                        if (sheet.settings.showTotals && data.section === 'body' && data.row.index === tableBody.length - 1) {
                            data.cell.styles.fontStyle = 'bold';
                            data.cell.styles.fillColor = [241, 245, 249];
                        }
                    },
                    didDrawPage: (data) => { currentY = data.cursor.y + 20; } 
                });
            }
            
            await this.updateProgress(80, 'Calculando Tablas Pivot...');

            const rowsForPivot = getRowsForSheet(sheet, parsedData);
            if (sheet.subTables && sheet.subTables.length > 0) {
                sheet.subTables.forEach(sub => {
                    if (!sub.groupByField) return; const pivotObj = calculatePivotData(rowsForPivot, sub, parsedData, this.baseColumns); const pivotData = pivotObj.data; if (!pivotData || pivotData.length === 0) return;
                    const baseCol = this.baseColumns.find(c => c.apiName === sub.groupByField); let valLabel = 'Recuento'; if (sub.operation !== 'COUNT' && sub.metricField) { const mCol = this.baseColumns.find(c => c.apiName === sub.metricField); valLabel = sub.operation === 'SUM' ? `Suma de ${mCol ? mCol.label : 'Valor'}` : `Promedio de ${mCol ? mCol.label : 'Valor'}`; }
                    const subBg = this.hexToRgb(sub.headerColor || '#263B7A'); const subTxt = this.hexToRgb(sub.headerTextColor || '#FFFFFF'); const subDataBg = this.hexToRgb(sub.dataColor || '#FFFFFF'); const subDataTxt = this.hexToRgb(sub.dataTextColor || '#000000');
                    if (currentY > doc.internal.pageSize.height - 100) { doc.addPage(); currentY = 40; }
                    
                    let customTitle = sub.title ? sub.title : `Pivot: ${baseCol ? baseCol.label : sub.groupByField}`;
                    const pivotPdfFace = sub.font ? this.normalizeThemeFontName(sub.font, this.getWorkbookFont()) : this.getWorkbookFont();
                    const pivotFont = this.resolvePdfBuiltinFont(pivotPdfFace);

                    if (sub.orientation === 'horizontal') {
                        const hHeaders = pivotData.map(p => p.label); hHeaders.push('Total'); const hValues = pivotData.map(p => p.displayValue); hValues.push(sub.operation === 'COUNT' ? pivotObj.total : Number(pivotObj.total).toLocaleString('es-ES', { minimumFractionDigits: 2 })); doc.setFontSize(10); doc.setTextColor(subBg[0], subBg[1], subBg[2]); doc.text(customTitle, marginX, currentY); currentY += 10;
                        doc.autoTable({ startY: currentY, head: [hHeaders], body: [hValues], theme: 'grid', styles: { font: pivotFont, fontSize: 8, halign: 'center' }, headStyles: { fillColor: subBg, textColor: subTxt }, bodyStyles: { fillColor: subDataBg, textColor: subDataTxt }, margin: { left: marginX, right: marginX }, didDrawPage: (data) => { currentY = data.cursor.y + 20; } });
                    } else {
                        const vBody = pivotData.map(p => [p.label, p.displayValue]); vBody.push(['Total', sub.operation === 'COUNT' ? pivotObj.total : Number(pivotObj.total).toLocaleString('es-ES', { minimumFractionDigits: 2 })]); doc.autoTable({ startY: currentY, head: [[customTitle, valLabel]], body: vBody, theme: 'grid', styles: { font: pivotFont, fontSize: 8 }, headStyles: { fillColor: subBg, textColor: subTxt }, bodyStyles: { fillColor: subDataBg, textColor: subDataTxt }, willDrawCell: (data) => { if (data.row.index === vBody.length - 1 && data.section === 'body') { doc.setFillColor(subBg[0], subBg[1], subBg[2]); doc.setTextColor(subTxt[0], subTxt[1], subTxt[2]); doc.setFont(undefined, 'bold'); } }, margin: { left: marginX, right: marginX }, tableWidth: 250, didDrawPage: (data) => { currentY = data.cursor.y + 20; } });
                    }
                });
            }

            /* F5: gráficos como imágenes al final del PDF. Solo de la hoja activa. */
            try {
                if (sheet.id === this.activeSheetId && Array.isArray(sheet.charts) && sheet.charts.length) {
                    sheet.charts.forEach(ch => {
                        const canvas = this.template.querySelector(`canvas[data-chart-id="${ch.id}"]`);
                        if (!canvas) return;
                        if (currentY > doc.internal.pageSize.height - 180) { doc.addPage(); currentY = 40; }
                        const dataUrl = canvas.toDataURL('image/png');
                        const imgWidthPt = 360;
                        const imgHeightPt = 200;
                        doc.addImage(dataUrl, 'PNG', marginX, currentY, imgWidthPt, imgHeightPt);
                        currentY += imgHeightPt + 20;
                    });
                }
            } catch (chartErr) { console.warn('Error embebiendo gráficos en PDF:', chartErr); }

            await this.updateProgress(100, '¡PDF Listo!');
            doc.save(`${this.getExportFileBaseName(sheet)}.pdf`); 
        } catch (e) { 
            console.error('ERROR generarPdfLocal:', e); 
            this.showToast('Error', 'Falló la generación del PDF.', 'error'); 
        } finally { 
            setTimeout(() => { this.isExporting = false; }, 500);
        }
    }

    hexToRgb(hex) { let c; if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){ c= hex.substring(1).split(''); if(c.length== 3){ c= [c[0], c[0], c[1], c[1], c[2], c[2]]; } c= '0x'+c.join(''); return [(c>>16)&255, (c>>8)&255, c&255]; } return [255,255,255]; }
    
    buildPdfColumnStyles(visibleColumns, availablePageWidth, tableBody, sheetSettings) {
        let styles = {};
        const globalBg = sheetSettings && sheetSettings.globalDataColor ? sheetSettings.globalDataColor : '#FFFFFF';
        const globalTxt = sheetSettings && sheetSettings.globalDataTextColor ? sheetSettings.globalDataTextColor : '#000000';
        let colMaxLengths = visibleColumns.map((col, i) => {
            let maxLen = (col.alias || col.label).length;
            if (tableBody && tableBody.length > 0) {
                tableBody.forEach(row => {
                    let cellLen = row[i] ? String(row[i]).length : 0;
                    if (cellLen > maxLen) maxLen = cellLen;
                });
            }
            return Math.min(120, Math.max(10, maxLen));
        });

        let totalContentLength = colMaxLengths.reduce((a, b) => a + b, 0);
        let totalUIWidth = visibleColumns.reduce((acc, col) => acc + (col.width || 120), 0);
        let useSmartFit = visibleColumns.every(c => !c.width || c.width === 120);

        visibleColumns.forEach((col, index) => {
            const alignMap = { left: 'left', center: 'center', right: 'right' };
            const eff = this.getEffectiveDataHorizontalAlign(col);
            let colDef = { halign: alignMap[eff] || 'left' };

            if (col.dataColor && col.dataColor.toUpperCase() !== '#FFFFFF') colDef.fillColor = this.hexToRgb(col.dataColor);
            else if (globalBg.toUpperCase() !== '#FFFFFF') colDef.fillColor = this.hexToRgb(globalBg);

            if (col.textColor) colDef.textColor = this.hexToRgb(col.textColor);
            else colDef.textColor = this.hexToRgb(globalTxt);

            let widthPercentage;
            if (useSmartFit && totalContentLength > 0) {
                widthPercentage = colMaxLengths[index] / totalContentLength;
            } else {
                widthPercentage = (col.width || 120) / totalUIWidth;
            }

            colDef.cellWidth = availablePageWidth * widthPercentage;
            styles[index] = colDef;
        });
        return styles;
    }

    async generarExcelLocal() {
        if (!this.excelJsLoaded || !window.ExcelJS) { this.showToast('Validación', 'ExcelJS no cargado.', 'warning'); return; }
        const workbookValidation = this.validateAllSheetsForExport();
        if (!workbookValidation.valid) {
            const detail = workbookValidation.issues.slice(0, 4).map(i => `• ${i.sheet}: ${i.message}`).join('\n');
            const extra = workbookValidation.issues.length > 4 ? `\n…y ${workbookValidation.issues.length - 4} más.` : '';
            this.showToast('Hojas con problemas', `${detail}${extra}`, 'warning', 'sticky');
            return;
        }
        
        this.isExporting = true;
        await this.updateProgress(10, 'Iniciando motor de Excel...');
        
        try {
            const workbook = new window.ExcelJS.Workbook(); workbook.creator = 'Pandora'; workbook.created = new Date(); const usedSheetNames = new Set();
            
            await this.updateProgress(40, 'Estructurando hojas y datos...');

            this.workbookConfig.sheets.forEach(sheetConfig => { 
                let sheetJson = this.reportDataJson;
                if (this.reportContexts && sheetConfig.sourceReportId && this.reportContexts[sheetConfig.sourceReportId]) {
                    sheetJson = this.reportContexts[sheetConfig.sourceReportId].json;
                }
                
                if (!sheetJson) {
                    const warnSheet = workbook.addWorksheet(this.getUniqueSheetName(sheetConfig.name || 'Sin Datos', usedSheetNames));
                    warnSheet.addRow(['No se pudieron cargar los datos para esta hoja. (Abra la hoja en Pandora para cachearla)']);
                    return;
                }

                const parsedData = JSON.parse(sheetJson);
                const baseColumnsForSheet = this.getBaseColumnsForSheet(sheetConfig);
                if (sheetConfig.type === 'summary') this.buildSummarySheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet);
                else this.buildDetailSheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet); 
            });

            await this.updateProgress(70, 'Compilando archivo nativo...');

            const buffer = await workbook.xlsx.writeBuffer(); 
            const blob = new Blob([buffer], { type: 'application/octet-stream' }); 
            const url = URL.createObjectURL(blob); 
            const anchor = document.createElement('a'); 
            anchor.href = url; anchor.download = `${this.getExportFileBaseName(this.activeSheet)}.xlsx`; anchor.style.display = 'none'; 
            
            await this.updateProgress(100, '¡Descargando Excel!');

            document.body.appendChild(anchor); anchor.click(); 
            setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(anchor); }, 0);
        } catch (e) { 
            console.error('ERROR generarExcelLocal:', e); 
            this.showToast('Error de Exportación', e.message || 'Fallo el procesamiento interno del archivo.', 'error'); 
        } finally {
            setTimeout(() => { this.isExporting = false; }, 500);
        }
    }

    async avanzarAPpt() {
        if (!this.excelJsLoaded || !window.ExcelJS) {
            this.showToast('Validación', 'ExcelJS aún no está listo. Espera unos segundos e inténtalo de nuevo.', 'warning');
            return;
        }
        /* Guard de variante: el reportePptBuilder asocia su diseño a la varianteId.
           Si llegamos aquí sin variante elegida, abriríamos el constructor contra
           una variante "default implícita" que probablemente no es la que tiene
           el diseño del usuario → confusión de "PPT desaparecido". Forzamos elegir. */
        if (!this.currentVariantId) {
            this.showToast(
                'Selecciona una variante',
                'El diseño de PPT está asociado a cada variante del reporte. Elige una variante antes de avanzar a PPT.',
                'warning'
            );
            this.openVariantManagerModal();
            return;
        }
        const exportValidation = this.validateActiveSheetForExport();
        if (!exportValidation.valid) { this.showToast('Validación', exportValidation.message, 'warning'); return; }
        
        this.isExporting = true;
        await this.updateProgress(15, 'Preparando lienzo para la Presentación...');
        
        try {
            const workbook = new window.ExcelJS.Workbook(); workbook.creator = 'Pandora'; workbook.created = new Date(); const usedSheetNames = new Set();
            this.workbookConfig.sheets.forEach(sheetConfig => { 
                let sheetJson = this.reportDataJson;
                if (this.reportContexts && sheetConfig.sourceReportId && this.reportContexts[sheetConfig.sourceReportId]) {
                    sheetJson = this.reportContexts[sheetConfig.sourceReportId].json;
                }
                
                if (!sheetJson) {
                    const warnSheet = workbook.addWorksheet(this.getUniqueSheetName(sheetConfig.name || 'Sin Datos', usedSheetNames));
                    warnSheet.addRow(['No se pudieron cargar los datos.']);
                    return;
                }

                const parsedData = JSON.parse(sheetJson);
                const baseColumnsForSheet = this.getBaseColumnsForSheet(sheetConfig);
                if (sheetConfig.type === 'summary') this.buildSummarySheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet);
                else this.buildDetailSheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet); 
            });

            await this.updateProgress(45, 'Inyectando estilos en caché...');

            const buffer = await workbook.xlsx.writeBuffer(); 
            const blob = new Blob([buffer], { type: 'application/octet-stream' });
            
            await this.updateProgress(75, 'Transfiriendo archivo base a PPT...');

            const reader = new FileReader();
            reader.onerror = () => {
                this.showToast('Error', 'No se pudo leer el Excel generado para el paso de PowerPoint.', 'error');
                this.isExporting = false;
            };
            reader.onloadend = async () => {
                if (!reader.result || typeof reader.result !== 'string') {
                    this.showToast('Error', 'Salida Excel vacía para PowerPoint.', 'error');
                    this.isExporting = false;
                    return;
                }
                const comma = reader.result.indexOf(',');
                const base64Data = comma >= 0 ? reader.result.slice(comma + 1) : '';
                if (!base64Data) {
                    this.showToast('Error', 'No se obtuvo el contenido en Base64 para PowerPoint.', 'error');
                    this.isExporting = false;
                    return;
                }
                /* Metadatos de variante del reporte: se propagan al PPT builder
                   para que pueda mostrar el contexto y usarlo en el nombre del .pptx.
                   No se persiste en el PPT (la config PPT sigue siendo por reportId). */
                const varianteId = this.currentVariantId || null;
                const varianteName = this.currentVariantName || null;
                /* Para no sobreescribir el Excel puente entre variantes distintas, el filename
                   incluye un segmento derivado de la variante cuando exista. */
                const safeVariantSegment = varianteId
                    ? `_${String(varianteId).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 16)}`
                    : '';
                try {
                    sessionStorage.setItem('pandora_transit_excel_base64', base64Data);
                    await this.updateProgress(100, '¡Lienzo PPT listo!');
                    this.dispatchEvent(new CustomEvent('nextstep', { detail: { isMemoryTransfer: true, sheetName: this.workbookConfig.sheets[0].name, reportId: this.selectedReportId, varianteId, varianteName } }));
                } catch (quotaError) {
                    console.warn('Memoria RAM llena. Enviando a Salesforce como puente de seguridad...', quotaError);
                    await this.updateProgress(85, 'Memoria llena. Usando Salesforce como puente...');
                    const savedExcelId = await saveExcelToSalesforce({ base64Data: base64Data, fileName: `Reporte_Base_PPT${safeVariantSegment}`, recordId: this.recordId });
                    await this.updateProgress(100, '¡Lienzo PPT listo!');
                    this.dispatchEvent(new CustomEvent('nextstep', { detail: { excelDocumentId: savedExcelId, sheetName: this.workbookConfig.sheets[0].name, reportId: this.selectedReportId, varianteId, varianteName } }));
                }
                setTimeout(() => { this.isExporting = false; }, 500);
            };
            reader.readAsDataURL(blob);

        } catch (e) { 
            console.error('ERROR avanzarAPpt:', e); 
            this.showToast('Error', 'Fallo al preparar PowerPoint. ' + (e.message || ''), 'error'); 
            this.isExporting = false;
        } 
    }

    getColLetter(num) { let letter = ''; while (num > 0) { let mod = (num - 1) % 26; letter = String.fromCharCode(65 + mod) + letter; num = Math.floor((num - mod) / 26); } return letter; }

    renderExcelSubTable(worksheet, sub, pivotObj, baseCol, valLabel, opts) {
        const pivotData = pivotObj.data; if (!pivotData || pivotData.length === 0) return;
        const { skipLeadingSpacers = false } = opts || {};
        const subBg = sub.headerColor || '#263B7A'; const subTxt = sub.headerTextColor || '#FFFFFF'; const subDataBg = sub.dataColor || '#FFFFFF'; const subTxtData = sub.dataTextColor || '#000000';
        const opMap = { 'COUNT': 'SUM', 'SUM': 'SUM', 'AVG': 'AVERAGE' };
        
        let customTitle = sub.title ? sub.title : `Pivot: ${baseCol ? baseCol.label : sub.groupByField}`;
        const excelFont = sub.font ? this.normalizeThemeFontName(sub.font, this.getWorkbookFont()) : this.getWorkbookFont();

        if (!skipLeadingSpacers) {
            worksheet.addRow([]); worksheet.addRow([]);
        } 
        if (sub.orientation === 'horizontal') {
            const titleRow = worksheet.addRow([customTitle]); titleRow.getCell(1).font = { name: excelFont, bold: true, color: { argb: this.toArgb(subBg) } };
            const hRow = worksheet.addRow([...pivotData.map(p => p.label), 'Total']); hRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(subBg) } }; c.font = { name: excelFont, bold: true, color: { argb: this.toArgb(subTxt) } }; c.border = this.defaultBorder(); c.alignment = { horizontal: 'center' }; });
            const vRowData = pivotData.map(p => p.value); const vRow = worksheet.addRow(vRowData); 
            const startColLetter = this.getColLetter(1); const endColLetter = this.getColLetter(pivotData.length);
            const totalCell = vRow.getCell(pivotData.length + 1); totalCell.value = { formula: `${opMap[sub.operation]}(${startColLetter}${vRow.number}:${endColLetter}${vRow.number})`, result: pivotObj.total };
            vRow.eachCell((c, idx) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(subDataBg) } }; c.font = { name: excelFont, color: { argb: this.toArgb(subTxtData) } }; c.border = this.defaultBorder(); c.alignment = { horizontal: 'center' }; if(sub.operation !== 'COUNT') c.numFmt = '#,##0.00'; });
            totalCell.font = { name: excelFont, bold: true, color: { argb: this.toArgb(subTxtData) } };
        } else {
            const subH = worksheet.addRow([customTitle, valLabel]); subH.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(subBg) } }; c.font = { name: excelFont, bold: true, color: { argb: this.toArgb(subTxt) } }; c.border = this.defaultBorder(); });
            const startRowNum = worksheet.rowCount + 1;
            pivotData.forEach(item => { const r = worksheet.addRow([item.label, item.value]); r.eachCell((c, colNum) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(subDataBg) } }; c.font = { name: excelFont, color: { argb: this.toArgb(subTxtData) } }; c.border = this.defaultBorder(); if(colNum === 2 && sub.operation !== 'COUNT') c.numFmt = '#,##0.00'; }); });
            const endRowNum = worksheet.rowCount;
            const tRow = worksheet.addRow(['Total', '']); const tCell = tRow.getCell(2); tCell.value = { formula: `${opMap[sub.operation]}(B${startRowNum}:B${endRowNum})`, result: pivotObj.total };
            tRow.eachCell((c, colNum) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(subBg) } }; c.font = { name: excelFont, bold: true, color: { argb: this.toArgb(subTxt) } }; c.border = this.defaultBorder(); if(colNum === 2 && sub.operation !== 'COUNT') c.numFmt = '#,##0.00'; });
        }
    }

    buildDetailSheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet) {
        const worksheet = workbook.addWorksheet(this.getUniqueSheetName(sheetConfig.name, usedSheetNames));
        const sheetCols = baseColumnsForSheet || this.getBaseColumnsForSheet(sheetConfig);

        /* X5: aplicar zoom de preview al worksheet (pageSetup + view zoomScale).
           Excel acepta 10-400 en zoomScale; respetamos límites razonables. */
        try {
            const z = parseInt(this.previewZoom || 100, 10);
            if (Number.isFinite(z) && z !== 100) {
                const zoomScale = Math.max(10, Math.min(400, z));
                if (Array.isArray(worksheet.views) && worksheet.views.length) {
                    worksheet.views = worksheet.views.map(v => ({ ...v, zoomScale, zoomScaleNormal: zoomScale }));
                } else {
                    worksheet.views = [{ zoomScale, zoomScaleNormal: zoomScale }];
                }
                if (worksheet.pageSetup) worksheet.pageSetup.scale = zoomScale;
            }
        } catch (e) { /* no bloquear export por zoom */ }

        const effectiveTableStart = getEffectiveExcelTableStartRow(sheetConfig);
        for (let i = 1; i < effectiveTableStart; i++) { worksheet.addRow([]); }
        this.addExcelLogoToWorksheet(workbook, worksheet, sheetConfig, effectiveTableStart);
        const rows = getRowsForSheet(sheetConfig, parsedData); this.buildTableInWorksheet(worksheet, sheetConfig, rows, parsedData, effectiveTableStart);
        const subs = (sheetConfig.subTables || [])
            .filter((sub) => sub.groupByField)
            .map((sub) => {
                const pivotObj = calculatePivotData(rows, sub, parsedData, sheetCols);
                const baseCol = sheetCols.find((c) => c.apiName === sub.groupByField);
                let valLabel = 'Recuento';
                if (sub.operation !== 'COUNT' && sub.metricField) {
                    const mCol = sheetCols.find((c) => c.apiName === sub.metricField);
                    valLabel = sub.operation === 'SUM' ? `Suma de ${mCol ? mCol.label : 'Valor'}` : `Promedio de ${mCol ? mCol.label : 'Valor'}`;
                }
                return { sub, pivotObj, baseCol, valLabel };
            })
            .filter((x) => x.pivotObj?.data?.length > 0);

        subs.sort((a, b) => {
            const ra = typeof a.sub.excelStartRow === 'number' && a.sub.excelStartRow > 0 ? a.sub.excelStartRow : 999999;
            const rb = typeof b.sub.excelStartRow === 'number' && b.sub.excelStartRow > 0 ? b.sub.excelStartRow : 999999;
            return ra - rb;
        });

        subs.forEach(({ sub, pivotObj, baseCol, valLabel }) => {
            const want = typeof sub.excelStartRow === 'number' && sub.excelStartRow > 0 ? sub.excelStartRow : null;
            let skip = false;
            if (want != null) {
                const startRow = Math.max(want, worksheet.rowCount + 1);
                while (worksheet.rowCount < startRow - 1) worksheet.addRow([]);
                skip = true;
            }
            this.renderExcelSubTable(worksheet, sub, pivotObj, baseCol, valLabel, { skipLeadingSpacers: skip });
        });
        /* F5: gráficos como imágenes al final de la hoja en Excel. Solo para
           la hoja activa (la única cuyos canvases están renderizados en el DOM).
           Para exportar charts de otras hojas, el usuario debe activarlas primero. */
        this._appendChartImagesToWorksheet(workbook, worksheet, sheetConfig);
    }
    _appendChartImagesToWorksheet(workbook, worksheet, sheetConfig) {
        try {
            if (!sheetConfig || sheetConfig.id !== this.activeSheetId) return;
            if (!Array.isArray(sheetConfig.charts) || !sheetConfig.charts.length) return;
            let row = worksheet.rowCount + 3;
            sheetConfig.charts.forEach(ch => {
                const canvas = this.template.querySelector(`canvas[data-chart-id="${ch.id}"]`);
                if (!canvas) return;
                const dataUrl = canvas.toDataURL('image/png');
                const base64 = dataUrl.split(',')[1];
                const imgId = workbook.addImage({ base64, extension: 'png' });
                worksheet.addImage(imgId, {
                    tl: { col: 0, row: row - 1 },
                    ext: { width: 480, height: 300 }
                });
                row += 18; // ~18 filas por imagen
            });
        } catch (e) {
            console.warn('No se pudieron embeber los gráficos en Excel:', e);
        }
    }

    buildGroupedSheets(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet) { this.buildDetailSheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet); }

    buildSummarySheet(workbook, sheetConfig, parsedData, usedSheetNames, baseColumnsForSheet) {
        const worksheet = workbook.addWorksheet(this.getUniqueSheetName(sheetConfig.name, usedSheetNames));
        const sheetCols = baseColumnsForSheet || this.getBaseColumnsForSheet(sheetConfig);

        const effectiveTableStart = getEffectiveExcelTableStartRow(sheetConfig);
        for (let i = 1; i < effectiveTableStart; i++) { worksheet.addRow([]); }
        this.addExcelLogoToWorksheet(workbook, worksheet, sheetConfig, effectiveTableStart);
        const rows = getRowsForSheet(sheetConfig, parsedData);
        const subs = (sheetConfig.subTables || [])
            .filter((sub) => sub.groupByField)
            .map((sub) => {
                const pivotObj = calculatePivotData(rows, sub, parsedData, sheetCols);
                const baseCol = sheetCols.find((c) => c.apiName === sub.groupByField);
                let valLabel = 'Recuento';
                if (sub.operation !== 'COUNT' && sub.metricField) {
                    const mCol = sheetCols.find((c) => c.apiName === sub.metricField);
                    valLabel = sub.operation === 'SUM' ? `Suma de ${mCol ? mCol.label : 'Valor'}` : `Promedio de ${mCol ? mCol.label : 'Valor'}`;
                }
                return { sub, pivotObj, baseCol, valLabel };
            })
            .filter((x) => x.pivotObj?.data?.length > 0);

        if (!subs.length) {
            worksheet.addRow(['Configura al menos una Sub-Tabla Pivot.']);
            return;
        }

        subs.sort((a, b) => {
            const ra = typeof a.sub.excelStartRow === 'number' && a.sub.excelStartRow > 0 ? a.sub.excelStartRow : 999999;
            const rb = typeof b.sub.excelStartRow === 'number' && b.sub.excelStartRow > 0 ? b.sub.excelStartRow : 999999;
            return ra - rb;
        });

        subs.forEach(({ sub, pivotObj, baseCol, valLabel }, idx) => {
            const want = typeof sub.excelStartRow === 'number' && sub.excelStartRow > 0 ? sub.excelStartRow : null;
            let skip = false;
            if (want != null) {
                const startRow = Math.max(want, worksheet.rowCount + 1);
                while (worksheet.rowCount < startRow - 1) worksheet.addRow([]);
                skip = true;
            } else if (idx > 0) {
                worksheet.addRow([]);
                worksheet.addRow([]);
            }
            this.renderExcelSubTable(worksheet, sub, pivotObj, baseCol, valLabel, { skipLeadingSpacers: skip });
        });
    }

    /* Y2/Y3: drag-and-drop + resize del logo en el lienzo.
       - Click sobre el logo (no en handle) → drag.
       - Click sobre el handle SE (esquina inferior derecha) → resize.
       - Suelta el mouse → commit a settings.logoX/logoY/logoWidth/logoHeight. */
    @track _logoDragging = false;
    @track _logoResizing = false;
    @track _logoDragDeltaX = 0;
    @track _logoDragDeltaY = 0;
    @track _logoResizeDeltaW = 0;
    @track _logoResizeDeltaH = 0;
    _logoDragStart = null;
    handleLogoMouseDown(event) {
        if (!this.activeSheet || !this.activeSheet.settings || !this.activeSheet.settings.logoBase64) return;
        event.preventDefault();
        event.stopPropagation();
        const s = this.activeSheet.settings;
        this._logoDragStart = {
            x: event.clientX,
            y: event.clientY,
            originX: this._effectiveLogoX(s),
            originY: this._effectiveLogoY(s)
        };
        this._logoDragging = true;
        this._logoDragDeltaX = 0;
        this._logoDragDeltaY = 0;
        this._boundLogoMoveMove = this._onLogoMoveMouseMove.bind(this);
        this._boundLogoMoveUp   = this._onLogoMoveMouseUp.bind(this);
        document.addEventListener('mousemove', this._boundLogoMoveMove, false);
        document.addEventListener('mouseup',   this._boundLogoMoveUp,   false);
    }
    _onLogoMoveMouseMove(event) {
        if (!this._logoDragging || !this._logoDragStart) return;
        this._logoDragDeltaX = event.clientX - this._logoDragStart.x;
        this._logoDragDeltaY = event.clientY - this._logoDragStart.y;
    }
    _onLogoMoveMouseUp() {
        if (this._logoDragging && this.activeSheet) {
            const s = this.activeSheet.settings;
            const baseX = this._effectiveLogoX(s);
            const baseY = this._effectiveLogoY(s);
            const newX = Math.max(0, Math.round(baseX + this._logoDragDeltaX));
            const newY = Math.max(0, Math.round(baseY + this._logoDragDeltaY));
            /* Recalculamos logoCol/logoRow para compatibilidad legacy (Excel/PDF antiguos). */
            const colIndex = Math.max(0, Math.min(25, Math.round(newX / 120)));
            const colLetter = String.fromCharCode(65 + colIndex);
            const rowNum = Math.max(1, Math.round(newY / (s.dataRowHeight || 24)) + 1);
            this.updateActiveSheet({ settings: { ...s, logoX: newX, logoY: newY, logoCol: colLetter, logoRow: rowNum } });
        }
        this._logoDragging = false;
        this._logoDragDeltaX = 0;
        this._logoDragDeltaY = 0;
        this._logoDragStart = null;
        if (this._boundLogoMoveMove) document.removeEventListener('mousemove', this._boundLogoMoveMove, false);
        if (this._boundLogoMoveUp)   document.removeEventListener('mouseup',   this._boundLogoMoveUp,   false);
        this._boundLogoMoveMove = null;
        this._boundLogoMoveUp   = null;
    }
    handleLogoResizeMouseDown(event) {
        if (!this.activeSheet || !this.activeSheet.settings || !this.activeSheet.settings.logoBase64) return;
        event.preventDefault();
        event.stopPropagation();
        const s = this.activeSheet.settings;
        this._logoDragStart = {
            x: event.clientX,
            y: event.clientY,
            originW: Number(s.logoWidth)  || 140,
            originH: Number(s.logoHeight) || 45
        };
        this._logoResizing = true;
        this._logoResizeDeltaW = 0;
        this._logoResizeDeltaH = 0;
        this._boundLogoResizeMove = this._onLogoResizeMouseMove.bind(this);
        this._boundLogoResizeUp   = this._onLogoResizeMouseUp.bind(this);
        document.addEventListener('mousemove', this._boundLogoResizeMove, false);
        document.addEventListener('mouseup',   this._boundLogoResizeUp,   false);
    }
    _onLogoResizeMouseMove(event) {
        if (!this._logoResizing || !this._logoDragStart) return;
        this._logoResizeDeltaW = event.clientX - this._logoDragStart.x;
        this._logoResizeDeltaH = event.clientY - this._logoDragStart.y;
    }
    _onLogoResizeMouseUp() {
        if (this._logoResizing && this.activeSheet) {
            const s = this.activeSheet.settings;
            const newW = Math.max(20, Math.min(800, Math.round((this._logoDragStart.originW) + this._logoResizeDeltaW)));
            const newH = Math.max(20, Math.min(600, Math.round((this._logoDragStart.originH) + this._logoResizeDeltaH)));
            this.updateActiveSheet({ settings: { ...s, logoWidth: newW, logoHeight: newH } });
        }
        this._logoResizing = false;
        this._logoResizeDeltaW = 0;
        this._logoResizeDeltaH = 0;
        this._logoDragStart = null;
        if (this._boundLogoResizeMove) document.removeEventListener('mousemove', this._boundLogoResizeMove, false);
        if (this._boundLogoResizeUp)   document.removeEventListener('mouseup',   this._boundLogoResizeUp,   false);
        this._boundLogoResizeMove = null;
        this._boundLogoResizeUp   = null;
    }

    /* X7: Vista previa de impresión.
       Muestra una hoja A4 escalada con la tabla a la escala de impresión
       configurada (orientación + márgenes + zoom). Recalcula automáticamente
       las páginas estimadas y permite exportar directamente desde el modal. */
    @track showPrintPreviewModal = false;
    openPrintPreviewModal()  { this.showPrintPreviewModal = true; }
    closePrintPreviewModal() { this.showPrintPreviewModal = false; }
    handlePdfOrientationChange(event) {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, pdfOrientation: event.detail.value } });
    }
    handlePdfMarginChange(event) {
        if (!this.activeSheet) return;
        this.updateActiveSheet({ settings: { ...this.activeSheet.settings, pdfMargin: event.detail.value } });
    }
    get pdfOrientationOptions() {
        return [
            { label: 'Auto (depende del nº de columnas)', value: 'auto' },
            { label: 'Vertical (portrait)',               value: 'portrait' },
            { label: 'Horizontal (landscape)',            value: 'landscape' }
        ];
    }
    get pdfMarginOptions() {
        return [
            { label: 'Estrechos (10pt)',  value: 'narrow' },
            { label: 'Normales (20pt)',   value: 'normal' },
            { label: 'Anchos (40pt)',     value: 'wide' }
        ];
    }
    get effectivePdfOrientation() {
        const s = this.activeSheet && this.activeSheet.settings;
        const o = s && s.pdfOrientation ? s.pdfOrientation : 'auto';
        if (o === 'portrait' || o === 'landscape') return o;
        /* auto: > 5 columnas visibles → landscape, si no portrait. */
        const visible = (this.activeSheet ? this.activeSheet.columns : []).filter(c => c.visible).length;
        return visible > 5 ? 'landscape' : 'portrait';
    }
    get effectivePdfMargin() {
        const s = this.activeSheet && this.activeSheet.settings;
        const m = s && s.pdfMargin ? s.pdfMargin : 'normal';
        if (m === 'narrow') return 10;
        if (m === 'wide')   return 40;
        return 20;
    }
    get pdfOrientationValue() {
        return (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.pdfOrientation) || 'auto';
    }
    get pdfMarginValue() {
        return (this.activeSheet && this.activeSheet.settings && this.activeSheet.settings.pdfMargin) || 'normal';
    }
    /* Mini-preview: dimensiones del "papel" A4 en el modal (escalado 0.45). */
    get printSheetStyle() {
        const portrait = this.effectivePdfOrientation === 'portrait';
        const w = portrait ? 380 : 540; /* px, A4 aspect ratio 1:1.414 a escala. */
        const h = portrait ? 540 : 380;
        return `width:${w}px; height:${h}px;`;
    }
    get printSheetOrientationLabel() { return this.effectivePdfOrientation === 'portrait' ? 'Vertical' : 'Horizontal'; }
    get printSheetMarginLabel() { return `${this.effectivePdfMargin}pt`; }
    get printSheetRowsLabel() {
        if (!this.activeSheet) return '0 filas';
        const parsed = this.getParsedReportData();
        if (!parsed) return '0 filas';
        try { return `${getRowsForSheet(this.activeSheet, parsed).length} filas` }
        catch (e) { return '— filas' }
    }
    get printSheetColumnsLabel() {
        if (!this.activeSheet) return '0 columnas';
        const n = (this.activeSheet.columns || []).filter(c => c.visible).length;
        return `${n} columnas visibles`;
    }
    /* Estimación grosera: ~25 filas por página en portrait, ~18 en landscape (a 11pt). */
    get printSheetPagesLabel() {
        if (!this.activeSheet) return '~1 página';
        const parsed = this.getParsedReportData();
        if (!parsed) return '~1 página';
        try {
            const n = getRowsForSheet(this.activeSheet, parsed).length;
            const perPage = this.effectivePdfOrientation === 'portrait' ? 25 : 18;
            const pages = Math.max(1, Math.ceil(n / perPage));
            return `~${pages} página${pages === 1 ? '' : 's'}`;
        } catch (e) { return '~1 página'; }
    }
    exportPdfFromPreview() { this.closePrintPreviewModal(); this.generarPdfLocal(); }

    /* X6: Auto-fit ancho de columna — calcula el ancho ideal para cada columna visible
       basándose en el contenido más largo de la columna y el alias del header.
       Aplica al sheet activo (mismo flujo que la edición manual con el slider). */
    autoFitColumnWidths() {
        if (!this.activeSheet) return;
        const parsed = this.getParsedReportData(); if (!parsed) return;
        const rows = getRowsForSheet(this.activeSheet, parsed);
        const cols = this.activeSheet.columns || [];
        const PX_PER_CHAR = 7.5; /* Calibri 11pt aprox. */
        const PADDING_PX  = 22;  /* 8 padding cada lado + 6 borde/scroll. */
        const MIN_W = 80, MAX_W = 520;
        const wrap = !!(this.activeSheet.settings && this.activeSheet.settings.previewCellWrapWords);
        const nextCols = cols.map(c => {
            if (!c.visible) return c;
            let maxLen = String(c.alias || c.label || '').length;
            const cIdx = (parsed.reportMetadata && parsed.reportMetadata.detailColumns) ? parsed.reportMetadata.detailColumns.indexOf(c.apiName) : -1;
            for (const row of rows) {
                const cellData = c.isVirtual ? computeVirtualCellValue(row, c, parsed) : (cIdx >= 0 ? row.dataCells[cIdx] : null);
                const text = (cellData && (cellData.label || cellData.value)) || '';
                const s = String(text);
                /* Si wrap está activo, capamos a 60 chars/línea para no hacer columnas absurdas. */
                if (wrap) {
                    const longestLine = s.split(/\r?\n/).reduce((m, l) => Math.max(m, Math.min(l.length, 60)), 0);
                    if (longestLine > maxLen) maxLen = longestLine;
                } else if (s.length > maxLen) {
                    maxLen = s.length;
                }
                if (maxLen >= 80) break; /* corto para reportes grandes */
            }
            const ideal = Math.round(Math.min(MAX_W, Math.max(MIN_W, maxLen * PX_PER_CHAR + PADDING_PX)));
            return { ...c, width: ideal };
        });
        this.updateActiveSheet({ columns: nextCols });
        this.showToast('Anchos auto-ajustados', 'Las columnas visibles se ajustaron al contenido.', 'success');
    }

    /* X2: convierte '#RRGGBB' a [R,G,B] para jspdf-autotable. */
    _hexToRgbArray(hex) {
        const h = (hex || '#000000').replace('#', '');
        const norm = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        const n = parseInt(norm, 16);
        if (!Number.isFinite(n)) return [248, 250, 252];
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    /* W1: estima cuántas líneas ocupará un texto en una celda de Excel con wrap-text,
       dado el ancho de columna en píxeles. Aproximación basada en Calibri 11pt:
       ~7px por carácter promedio. Respeta saltos de línea explícitos del contenido. */
    _estimateExcelWrappedLines(text, colWidthPx) {
        if (!text) return 1;
        const usableWidthPx = Math.max(20, (colWidthPx || 120) - 16); /* 8px padding cada lado */
        const charsPerLine = Math.max(8, Math.floor(usableWidthPx / 7));
        let total = 0;
        const parts = String(text).split(/\r?\n/);
        for (const part of parts) {
            /* Para wrap real, contamos palabras y simulamos. Aprox: dividir longitud por charsPerLine,
               y añadir margen del 5% para líneas que cortan en palabras (no en letras). */
            const len = part.length;
            const lines = Math.max(1, Math.ceil(len / Math.max(1, charsPerLine - 2)));
            total += lines;
        }
        /* Cap razonable para no generar filas absurdamente grandes (Excel máx ≈ 27 líneas a 11pt). */
        return Math.min(total, 27);
    }
    buildTableInWorksheet(worksheet, sheetConfig, rows, parsedData, startRow) {
        const visibleColumns = (sheetConfig.columns || []).filter(column => column.visible).sort((a, b) => a.order - b.order);
        if (!visibleColumns.length) { worksheet.addRow(['No hay columnas visibles configuradas.']); return; }

        /* X5: tamaño de fuente según densidad (preview ↔ export). */
        const scale = (sheetConfig.settings && sheetConfig.settings.previewFontScale) || 'standard';
        const dataFontSize = scale === 'compact' ? 9 : (scale === 'large' ? 13 : 11);
        const headerFontSize = scale === 'compact' ? 10 : (scale === 'large' ? 14 : 11);

        const headerRow = worksheet.addRow(visibleColumns.map(column => column.alias || column.label)); 
        const headerRowNum = headerRow.number; headerRow.height = sheetConfig.settings && sheetConfig.settings.headerHeight ? sheetConfig.settings.headerHeight : 28;
        const totalCols = visibleColumns.length;
        headerRow.eachCell((cell, columnNumber) => { const columnConfig = visibleColumns[columnNumber - 1]; const bgColor = columnConfig.headerColor || (sheetConfig.settings && sheetConfig.settings.globalHeaderColor ? sheetConfig.settings.globalHeaderColor : '#0070C0'); const textColor = columnConfig.headerTextColor || (sheetConfig.settings && sheetConfig.settings.globalHeaderTextColor ? sheetConfig.settings.globalHeaderTextColor : '#FFFFFF'); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(bgColor) } }; cell.font = { name: this.getWorkbookFont(), bold: true, size: headerFontSize, color: { argb: this.toArgb(textColor) } }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = this.getCellBorder({ isHead: true, isFirstCol: columnNumber === 1, isLastCol: columnNumber === totalCols, isFirstRow: true, isLastRow: false }); });
        
        const wrapInExcel = !!(sheetConfig.settings && sheetConfig.settings.previewCellWrapWords);
        const baseRowHeight = sheetConfig.settings && sheetConfig.settings.dataRowHeight ? sheetConfig.settings.dataRowHeight : 24;
        const bandedActive = !!(sheetConfig.settings && sheetConfig.settings.bandedRows);
        const bandedArgb   = bandedActive ? this.toArgb((sheetConfig.settings && sheetConfig.settings.bandedRowColor) || '#F8FAFC') : null;
        rows.forEach((reportRow, rowIdx) => {
            const dataRow = worksheet.addRow([]);
            const isBandRow = bandedActive && (rowIdx % 2 === 1);
            /* W1: cuando wrap está activo, pre-calculamos la altura de la fila según
               el contenido y ancho de columna, así Excel muestra todo el texto al abrir
               sin necesidad de "auto-ajustar altura de fila" manualmente. */
            let rowMaxLines = 1;
            visibleColumns.forEach((columnConfig, index) => {
                const excelColumnNumber = index + 1; const reportColumnIndex = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns.indexOf(columnConfig.apiName) : -1; 
                let dataType = columnConfig.dataType;
                if (parsedData.reportExtendedMetadata && parsedData.reportExtendedMetadata.detailColumnInfo && parsedData.reportExtendedMetadata.detailColumnInfo[columnConfig.apiName]) {
                    dataType = parsedData.reportExtendedMetadata.detailColumnInfo[columnConfig.apiName].dataType;
                }
                const cellData = columnConfig.isVirtual ? computeVirtualCellValue(reportRow, columnConfig, parsedData) : (reportColumnIndex >= 0 ? reportRow.dataCells[reportColumnIndex] : null); 
                
                const cell = dataRow.getCell(excelColumnNumber); 
                
                cell.value = this.getExcelValue(cellData, dataType, columnConfig.format, sheetConfig); this.applyExcelFormat(cell, dataType, columnConfig.format, columnConfig.dateFormat);
                const bgColor = columnConfig.dataColor && columnConfig.dataColor.toUpperCase() !== '#FFFFFF' ? columnConfig.dataColor : (sheetConfig.settings && sheetConfig.settings.globalDataColor ? sheetConfig.settings.globalDataColor : '#FFFFFF');
                const txtColor = columnConfig.textColor || (sheetConfig.settings && sheetConfig.settings.globalDataTextColor ? sheetConfig.settings.globalDataTextColor : '#000000');
                /* X2: prioridad de fill — dataColor custom > banding > globalDataColor blanco. */
                if (bgColor.toUpperCase() !== '#FFFFFF') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.toArgb(bgColor) } };
                } else if (isBandRow && bandedArgb) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bandedArgb } };
                }
                /* U2: si 'Ajustar texto (varias líneas)' está activo en preview, lo
                   replicamos en Excel con wrapText: true. X5: tamaño según densidad. */
                cell.font = { name: this.getWorkbookFont(), size: dataFontSize, color: { argb: this.toArgb(txtColor) } };
                cell.alignment = { horizontal: this.getEffectiveDataHorizontalAlign(columnConfig), vertical: wrapInExcel ? 'top' : 'middle', wrapText: wrapInExcel };
                /* X8: bordes por celda según el modo configurado. La última fila se considera última
                   si NO va a haber fila de totales después; en ese caso, totals tendrá la última línea. */
                const isLastDataRow = (rowIdx === rows.length - 1) && !sheetConfig.settings.showTotals;
                cell.border = this.getCellBorder({ isHead: false, isFirstCol: index === 0, isLastCol: index === totalCols - 1, isFirstRow: false, isLastRow: isLastDataRow });

                if (wrapInExcel) {
                    const textVal = (cell.value instanceof Date) ? '' : String(cell.value ?? '');
                    if (textVal) {
                        const colWidthPx = (columnConfig.width || 120);
                        const lines = this._estimateExcelWrappedLines(textVal, colWidthPx);
                        if (lines > rowMaxLines) rowMaxLines = lines;
                    }
                }
            });
            if (wrapInExcel && rowMaxLines > 1) {
                /* Excel: ~15 puntos por línea a 11pt + 4pt de margen. Limitamos a 409.5 (máx. Excel). */
                dataRow.height = Math.min(rowMaxLines * 15 + 4, 409);
            } else {
                dataRow.height = baseRowHeight;
            }
        });
        
        // MEJORA 3: FILA DE TOTALES EN EXCEL
        if (sheetConfig.settings.showTotals) {
            const totalsRow = worksheet.addRow([]);
            visibleColumns.forEach((col, index) => {
                let cell = totalsRow.getCell(index + 1);
                if (index === 0) { 
                    cell.value = 'Total General';
                    cell.alignment = { horizontal: 'left', vertical: 'middle' };
                } else {
                    let isNumeric = ['DOUBLE', 'INT', 'CURRENCY', 'PERCENT'].includes((col.dataType||'').toUpperCase()) || col.format === 'number' || col.format === 'currency';
                    if (isNumeric) {
                        let sum = rows.reduce((acc, row) => {
                            const cIdx = (parsedData.reportMetadata && parsedData.reportMetadata.detailColumns) ? parsedData.reportMetadata.detailColumns.indexOf(col.apiName) : -1;
                            const cellData = col.isVirtual ? computeVirtualCellValue(row, col, parsedData) : (cIdx >= 0 ? row.dataCells[cIdx] : null);
                            return acc + (Number(cellData?.value) || 0);
                        }, 0);
                        cell.value = sum;
                        this.applyExcelFormat(cell, col.dataType, col.format, col.dateFormat);
                        cell.alignment = { horizontal: this.getEffectiveDataHorizontalAlign(col), vertical: 'middle' };
                    } else {
                        cell.value = '';
                        cell.alignment = { horizontal: 'center', vertical: 'middle' };
                    }
                }
                cell.font = { name: this.getWorkbookFont(), bold: true, size: 11 };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
                cell.border = this.getCellBorder({ isHead: false, isFirstCol: index === 0, isLastCol: index === totalCols - 1, isFirstRow: false, isLastRow: true });
            });
        }

        visibleColumns.forEach((columnConfig, index) => { worksheet.getColumn(index + 1).width = this.pixelToExcelWidth(columnConfig.width || 120); });
        /* F3: congelado horizontal en Excel (xSplit). Se combina con el congelado
           del header (ySplit) si está activo. Limita a min(N, visibleColumns-1) para
           que siempre haya al menos una columna desplazable. */
        const frozenCols = sheetConfig.settings && sheetConfig.settings.frozenColumns
            ? Math.min(parseInt(sheetConfig.settings.frozenColumns, 10) || 0, Math.max(visibleColumns.length - 1, 0))
            : 0;
        const freezeHeaderActive = sheetConfig.settings && sheetConfig.settings.freezeHeader;
        if (frozenCols > 0 || freezeHeaderActive) {
            worksheet.views = [{
                state: 'frozen',
                xSplit: frozenCols > 0 ? frozenCols : undefined,
                ySplit: freezeHeaderActive ? headerRowNum : undefined
            }];
        }
        if (sheetConfig.settings && sheetConfig.settings.autoFilter) worksheet.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: visibleColumns.length } };
    }

    /** Resuelve formato de celda Excel cuando el usuario dejó "Automático" (alineado con la vista previa). */
    resolveEffectiveExcelFormat(format, dataType) {
        const f = (format || 'auto').toLowerCase();
        if (f !== 'auto') return f;
        const dt = (dataType || '').toUpperCase();
        if (dt === 'CURRENCY') return 'currency';
        if (dt === 'PERCENT') return 'percent';
        if (dt === 'DATE') return 'date';
        if (dt === 'DATETIME') return 'datetime';
        if (dt === 'DOUBLE') return 'number';
        if (dt === 'INT') return 'integer';
        return 'text';
    }

    getExcelValue(cellData, dataType, format, sheet) {
        const normalize = (v) => this.normalizeBlankDisplayString(v, this.blankHyphenDisplaysAsEmpty(sheet));
        if (!cellData) return '';
        const rawValue = cellData.value;
        let labelValue = cellData.label != null ? String(cellData.label) : '';
        labelValue = normalize(labelValue);
        if (rawValue === null || rawValue === undefined || rawValue === '') {
            return normalize(labelValue);
        }
        const eff = this.resolveEffectiveExcelFormat(format, dataType);
        if (eff === 'date' || eff === 'datetime') {
            const dateValue = new Date(rawValue);
            if (Number.isNaN(dateValue.getTime())) return normalize(labelValue);
            return dateValue;
        }
        if (eff === 'text') {
            /* Para texto largo del Reports API, `label` puede venir truncado; `value` suele conservar más contenido. */
            const rawText = normalize(String(rawValue));
            const textOut = rawText !== '' ? rawText : labelValue;
            return textOut === undefined || textOut === null ? '' : textOut;
        }
        const numericKinds = ['number', 'integer', 'currency', 'percent'];
        if (numericKinds.includes(eff)) {
            let numericValue = Number(rawValue);
            if (Number.isNaN(numericValue)) return normalize(labelValue);
            if (eff === 'percent' || dataType === 'PERCENT') {
                if (numericValue > 1 && numericValue <= 100) numericValue /= 100;
            }
            if (eff === 'integer' || dataType === 'INT') return Math.round(numericValue);
            return numericValue;
        }
        return normalize(labelValue);
    }

    applyExcelFormat(cell, dataType, format, dateFormat) {
        const eff = this.resolveEffectiveExcelFormat(format, dataType);
        switch (eff) {
            case 'currency':
                cell.numFmt = '"$"#,##0.00';
                return;
            case 'date':
                cell.numFmt = this._excelNumFmtForDate(dateFormat || 'auto', false);
                return;
            case 'datetime':
                cell.numFmt = this._excelNumFmtForDate(dateFormat || 'auto', true);
                return;
            case 'percent':
                cell.numFmt = '0.00%';
                return;
            case 'number':
                cell.numFmt = '#,##0.00';
                return;
            case 'integer':
                cell.numFmt = '#,##0';
                return;
            case 'text':
                cell.numFmt = '@';
                return;
            default:
                break;
        }
    }

    /** Ancho de columna Excel (unidades “carácter” Calibri ~11), más cercano al ancho en px de la vista previa. */
    pixelToExcelWidth(pixelWidth) {
        const px = Number(pixelWidth) || 120;
        const charUnits = Math.max(0, (px - 10) / 6.4);
        return Math.round(Math.max(10, charUnits) * 10) / 10;
    }
    safeSheetName(name) { const cleanedName = (name || 'Hoja').replace(/[\\/?*[\]:]/g, '').substring(0, 31).trim(); return cleanedName || 'Hoja'; }
    /* Devuelve el nombre de archivo que se usa al exportar Excel / PDF.
       Prioridad: nombre de la variante activa > nombre del reporte > nombre de la hoja > fallback.
       Sanitiza para evitar caracteres prohibidos en sistemas de archivos. */
    getExportFileBaseName(sheet) {
        const candidates = [
            this.currentVariantName,
            this.selectedReportLabel,
            sheet && sheet.name,
            'Reporte_Personalizado'
        ];
        let raw = candidates.find(v => typeof v === 'string' && v.trim().length > 0) || 'Reporte';
        raw = String(raw).trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        return raw.substring(0, 80) || 'Reporte';
    }
    getUniqueSheetName(name, usedSheetNames) { const baseName = this.safeSheetName(name || 'Hoja'); let finalName = baseName; let counter = 2; while (usedSheetNames.has(finalName)) { const suffix = ` ${counter}`; finalName = `${baseName.substring(0, 31 - suffix.length)}${suffix}`; counter += 1; } usedSheetNames.add(finalName); return finalName; }
    toArgb(hexColor) { const cleanColor = (hexColor || '#FFFFFF').replace('#', '').toUpperCase(); if (cleanColor.length === 6) return `FF${cleanColor}`; if (cleanColor.length === 8) return cleanColor; return 'FFFFFFFF'; }
    defaultBorder() {
        /* Compatibilidad: usado por pivots/summary. Respeta color y grosor del modo,
           pero como no conocemos posición de celda, devuelve bordes en todos los lados
           si el modo no es 'none'. */
        const mode = this.borderStyleValue;
        if (mode === 'none') return {};
        const argb = this.toArgb(this.borderColorValue);
        const line = { style: this._excelLineStyle(), color: { argb } };
        if (mode === 'horizontal') return { top: line, bottom: line };
        if (mode === 'vertical') return { left: line, right: line };
        return { top: line, left: line, bottom: line, right: line };
    }
    getWorkbookFont() {
        const raw = this.workbookConfig && this.workbookConfig.theme && this.workbookConfig.theme.font
            ? this.workbookConfig.theme.font
            : 'Calibri';
        return this.normalizeThemeFontName(raw);
    }
    getSheetTypeLabel(type) { if (type === 'summary') return 'Hoja Resumen'; if (type === 'grouped') return 'Agrupación Simple'; return 'Tabla detalle'; }
    generateSheetId() { return `sheet_${Date.now()}_${Math.floor(Math.random() * 100000)}`; }
    showToast(title, message, variant, mode) { this.dispatchEvent(new ShowToastEvent({ title, message, variant, mode })); }
    disconnectedCallback() {
        window.removeEventListener('mousemove', this.handleColumnResizeMove); window.removeEventListener('mouseup', this.stopColumnResize); window.removeEventListener('mousemove', this.handleHeaderResizeMove); window.removeEventListener('mouseup', this.stopHeaderResize); window.removeEventListener('mousemove', this.handleRowResizeMove); window.removeEventListener('mouseup', this.stopRowResize);
        if (this._boundGlobalKeydown) window.removeEventListener('keydown', this._boundGlobalKeydown);
        if (this._boundQuickFilterDocClick) document.removeEventListener('click', this._boundQuickFilterDocClick, false);
        if (this._boundSavedViewsDocClick) document.removeEventListener('click', this._boundSavedViewsDocClick, false);
        if (this._autosaveInterval) { clearInterval(this._autosaveInterval); this._autosaveInterval = null; }
    }
}