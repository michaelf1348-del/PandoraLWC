import { LightningElement, track, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import currentUserId from '@salesforce/user/Id';
import getTicketsForEntry from '@salesforce/apex/ImputacionesAMSController.getTicketsForEntry';
import getTicketsByCaseNumbers from '@salesforce/apex/ImputacionesAMSController.getTicketsByCaseNumbers';
import getUiOptions from '@salesforce/apex/ImputacionesAMSController.getUiOptions';
import saveEntries from '@salesforce/apex/ImputacionesAMSController.saveEntries';
import validateEntries from '@salesforce/apex/ImputacionesAMSController.validateEntries';
import exportImputationsForMonth from '@salesforce/apex/ImputacionesAMSController.exportImputationsForMonth';
import getDailyHoursForMonth from '@salesforce/apex/ImputacionesAMSController.getDailyHoursForMonth';
import getMonthTicketsByBillable from '@salesforce/apex/ImputacionesAMSController.getMonthTicketsByBillable';
import getTicketHoursBreakdownForDay from '@salesforce/apex/ImputacionesAMSController.getTicketHoursBreakdownForDay';
import deleteImputationRecord from '@salesforce/apex/ImputacionesAMSController.deleteImputationRecord';
import updateImputationRecord from '@salesforce/apex/ImputacionesAMSController.updateImputationRecord';
import getCaseImputationLinesForEdit from '@salesforce/apex/ImputacionesAMSController.getCaseImputationLinesForEdit';
import getImputationCenterSettings from '@salesforce/apex/ImputacionesAMSController.getImputationCenterSettings';
import getOperativeThemeSettings from '@salesforce/apex/ImputacionesAMSController.getOperativeThemeSettings';
import previewIndForSelectedCases from '@salesforce/apex/ImputacionesAMSController.previewIndForSelectedCases';
import plantillaImputacionesBasicaUrl from '@salesforce/resourceUrl/ImputacionesAmsPlantilla';
import plantillaImputacionesAdminUrl from '@salesforce/resourceUrl/ImputacionesAmsPlantillaAdmin';
import {
    MONTH_NAMES,
    JORNADA_OBJETIVO_HORAS,
    CHILE_FIXED_HOLIDAY_MM_DD,
    FACTURABLE_TARGET_PCT_CODE
} from './imputacionesAMSSharedConstants';
import {
    normalizeSldsIconValue,
    repairPanelMetaCopyJson,
    repairPanelMetaFromParsed
} from './imputacionesPanelMetaUtil';
import {
    buildAdminCalcTransparencyModel,
    calcTransparencyHasWarnings
} from './imputacionesAMSMonitorTransparency';
import {
    openImputationCenterMonitorModal,
    tabValueFromMonitorActiveEvent
} from './imputacionesAMSMonitorModal';
import { isConsultantImputationDateAllowed } from './imputacionesAMSMonthWindowUtil';
import { buildUsageGuideModel } from './imputacionesAMSUsageGuide';
import {
    resolveChartColorsFromSettings,
    resolveCalendarCssVarsFromSettings,
    coerceOperativeThemeSettings,
    buildStripDayButtonInlineStyle,
    buildCalDayButtonInlineStyle
} from './imputacionesAMSThemeUtil';
import {
    parseBillableRulesFromSettings,
    resolveConsultantNoFacturableForSave
} from './imputacionesBillableRulesUtil';
import {
    buildExportCsvContent,
    caseNumberLookupKeys,
    countExactDuplicateImportLines,
    downloadTextFile,
    normalizeImportCaseNumber
} from './imputacionesImportExportUtil';

const FALLBACK_CATALOG_TABS = [
    { id: 'mine', label: 'Mis tickets', type: 'mine' },
    {
        id: 'ams',
        label: 'Gestion AMS',
        type: 'ams',
        supportsCreatedDateFilter: true,
        hint: ''
    }
];

const CSV_TEMPLATE_HEADER = 'CaseNumber;Horas;Fecha;NoFacturable;Comentario';
/** Columna opcional al final (solo admins): Id de usuario Salesforce del consultor en el registro. */
const CSV_TEMPLATE_HEADER_ADMIN_EXTRA = 'ConsultorId';

/** Anclar tickets: prefijo de clave en localStorage. Limite efectivo viene del objeto operativo (fallback abajo). */
const PINNED_STORAGE_PREFIX = 'imputacionesAMS.pinned';

/** Destaque suave en calendario cuando el día ya supera estas horas imputadas (fallback si no hay config). */
const DAY_HIGH_HOURS_HINT_DEFAULT = 8;

/** Fallback ancho franja de dias (si org no devuelve config). */
const STRIP_WINDOW_FALLBACK = 14;

const STRIP_WINDOW_MAX = 21;

/** Una letra por columna (Dom-Sab): menos ancho en panel lateral. */
const WEEKDAYS = [
    { key: 'dom', label: 'D' },
    { key: 'lun', label: 'L' },
    { key: 'mar', label: 'M' },
    { key: 'mie', label: 'X' },
    { key: 'jue', label: 'J' },
    { key: 'vie', label: 'V' },
    { key: 'sab', label: 'S' }
];

/** Último comentario del composer tras un guardado OK (solo este navegador). */
const STORAGE_LAST_COMMENT = 'ams_imputaciones_bulk_last_comment';

/** Panel «Rellenar selección» abierto / cerrado. */
const STORAGE_BULK_PANEL = 'ams_imput_bulk_panel_open';

/** Tipo de gráfico facturable (dona / barras). */
const STORAGE_CHART_TYPE = 'ams_imput_chart_type';

/** Vista calendario lateral en pantalla completa (quick action siempre barra). */
const STORAGE_SIDEBAR_CALENDAR = 'ams_imput_sidebar_calendar';

const CHART_TYPES = new Set(['donut', 'bars', 'stacked']);

export default class ImputacionesAMS extends LightningElement {
    /** Disponible cuando se abre como quick action de Case. */
    @api recordId;

    /** Lista de IDs inyectada por el Flow de Pantalla desde la vista de lista */
    @api recordIds;

    /** Modo compacto para quick action (inyectado por wrapper Aura). */
    @api quickActionMode = false;
    weekdays = WEEKDAYS;
    calendarMonthDate = new Date();
    calendarDays = [];
    /** isoDate -> horas totales ese día (consultor filtrado o usuario actual). */
    dailyHoursByDate = {};
    monthFacturableHours = 0;
    monthNoFacturableHours = 0;
    monthHasBreakdown = false;
    /** Q1..Q4 del año actual -> horas facturables acumuladas. */
    quarterFacturableHours = { 1: 0, 2: 0, 3: 0, 4: 0 };
    /** Desglose por trimestre con meses, meta y %. */
    quarterFacturableData = {
        1: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
        2: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
        3: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
        4: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 }
    };
    /** Indica que el panel trimestral se está recalculando (no bloquea UI). */
    quarterFacturableLoading = false;
    quarterDetailOpen = false;
    /** Versiones por carga: descartan respuestas obsoletas al cambiar rápido pestaña / mes / resolutor. */
    _loadTicketsVersion = 0;
    _loadMonthHoursVersion = 0;
    _loadQuarterVersion = 0;
    quarterDetailQ = 0;
    /** Popup de tickets del mes por facturable / no facturable. */
    @track monthMetaHelpModalOpen = false;
    @track ticketBillableModalOpen = false;
    @track ticketBillableModalKind = 'fact';
    @track ticketBillableLoading = false;
    @track ticketBillableRows = [];
    _ticketBillableCacheKey = '';
    _loadTicketBillableVersion = 0;

    selectedDates = [];

    @track rows = [];
    @track selectedRows = [];
    @track tableErrors = { rows: {} };

    entryDate;
    hours;
    noFacturable = false;
    comment;
    searchTerm = '';
    selectedOwnerId = '';
    /** Solo admins: Id de usuario en el registro Imputacion__c (vacío = quien guarda). */
    @track adminImputeOnBehalfUserId = '';
    ownerOptions = [];
    isLoading = false;
    /** Texto accesible del lightning-spinner. */
    loadingStatusText = 'Cargando';
    isImputationAdmin = false;

    settingsOpen = false;
    bulkPanelOpen = false;
    quickHoursEnabled = true;
    quickBillingEnabled = true;
    quickSettingsOpen = false;
    quickCommentsEnabled = false;

    ticketPageNumber = 0;
    hasMoreTickets = false;

    /** Modal de importación CSV (cabecera). */
    importModalOpen = false;

    usageGuideModalOpen = false;

    /** Resultado previo antes de aplicar importación `{ parsed, fileName, stats }`. */
    importParsedPreview;

    /** Líneas CSV adicionales (mismo ticket) pendientes de guardar con Confirmar imputación. */
    pendingImportExtraEntries = [];

    /** Fuerza remount del input file al cerrar modal. */
    importFileInputKey = 0;
    monthlyChartType = 'donut';
    ticketTabSource = 'mine';
    /** Filtro adicional pestaña Gestión AMS: rango de fecha de creación del ticket. */
    amsCreatedFromDate = '';
    amsCreatedToDate = '';
    /** True si el usuario interactuó con el filtro de fecha AMS (lo modificó o limpió).
     *  Mientras sea false, podemos pre-rellenarlo con el mes en curso al entrar al tab. */
    amsCreatedFilterTouched = false;
    /** Lista ordenada de caseIds anclados (tope: maxPinnedLimit). Persistido en localStorage. */
    pinnedTicketIds = [];
    preferenceSidebarCalendar = false;
    layoutSettingsOpen = false;
    stripDensity = 'comfortable';
    /**
     * Día (1..N) en que comienza la ventana visible de la franja.
     * `null` = autoanclar a hoy (o al día 1 si el mes mostrado no es el actual).
     * Se resetea a `null` en cada navegación de mes.
     */
    stripWindowStartDay = null;
    rowCommentModalOpen = false;
    rowCommentDraft = '';
    rowCommentRowId;
    rowCommentTicketLabel = '';
    rowDateModalOpen = false;
    rowDateRowId;
    rowDateTicketLabel = '';
    rowDateMonthDate = new Date();
    rowDateSelectedDates = [];
    rowDateIsDragging = false;
    rowDateDragAnchorIso = null;
    rowDateSuppressClick = false;

    /** Popup: tickets imputados en un día (barra o calendario). */
    dayDetailModalOpen = false;
    dayDetailIso = '';
    dayDetailLines = [];
    dayDetailLoading = false;

    /** Edición rápida de una línea de imputación (encima del popup de día). */
    dayEditModalOpen = false;
    dayEditImputationId = null;
    dayEditHoursStr = '';
    dayEditIsoDate = '';
    dayEditNoFacturable = false;
    dayEditComment = '';
    dayEditSaving = false;

    /** Modal lista de imputaciones del caso (lápiz en tabla). */
    caseImputationsModalOpen = false;
    caseImputationsEditLines = [];
    caseImputationsTicketLabel = '';
    caseImputationsEditCaseId = null;
    /** True en Gestión AMS para consultores: modal solo con imputaciones propias. */
    caseImputationsEditOwnLinesOnly = false;
    caseImputationsEditTicketHoursTotal = 0;
    caseImputationsEditUserHoursTotal = 0;
    /** Ticket de gestión AMS: no facturable se aplica al guardar (sin pedirlo al usuario). */
    caseImputationsEditCaseNoFactLocked = false;
    /** Orden en modal de imputaciones del ticket (true = más recientes arriba). */
    caseImputationsSortNewestFirst = true;
    caseImputationsEditCaseAllowsFutureDates = false;
    caseLineSavingId = null;

    /** Alta rápida desde el modal de imputaciones del caso. */
    caseImpDraftVisible = false;
    caseImpDraftHoursStr = '';
    caseImpDraftIsoDate = '';
    caseImpDraftNoFacturable = false;
    caseImpDraftComment = '';
    caseImpSavingNew = false;
    caseImpDeletingId = null;

    /** Cierre modal con Escape. */
    boundImportEscape = (event) => {
        if (event.key !== 'Escape') return;
        if (this.layoutSettingsOpen) {
            this.layoutSettingsOpen = false;
            return;
        }
        if (this.caseImputationsModalOpen) {
            if (this.caseImpSavingNew || this.caseImpDeletingId) {
                return;
            }
            if (this.caseImpDraftVisible) {
                this.cancelCaseImpAdd();
                return;
            }
            this.closeCaseImputationsModal();
            return;
        }
        if (this.dayEditModalOpen) {
            this.closeDayEditModal();
            return;
        }
        if (this.dayDetailModalOpen) {
            this.closeDayDetailModal();
            return;
        }
        if (this.imputationCenterSettingsOpen) {
            this.closeImputationCenterSettingsModal();
            return;
        }
        if (this.usageGuideModalOpen) {
            this.closeUsageGuideModal();
            return;
        }
        if (this.importModalOpen) {
            this.closeImportModal();
        }
    };

    /** Drag con botón izquierdo para marcar rango de días (strip / calendario). */
    isCalendarDragSelecting = false;
    suppressNextDayClick = false;
    /** Primer día del arrastre actual (ISO). */
    calendarDragAnchorIso = null;

    imputationCenterSettingsOpen = false;
    @track imputationCenterSettings = {};
    /** Incrementa al cargar tema para forzar repaint de franja/calendario. */
    @track operativeThemeGeneration = 0;
    operativeThemeReady = false;
    /** Cache de Criterios_Facturable_Filtros_JSON__c parseado (evita JSON.parse en cada getter). */
    _billableRulesParsed = null;
    _billableRulesJsonKey = '';
    _billableBreakdownDirty = true;
    _billableBreakdownCached = { fact: 0, noFact: 0, total: 0 };
    /**
     * Cache de FA/NF segun Ind_Imputacion__c por (caseId|plannedNoFacturable).
     * Solo se refresca al cambiar seleccion / No fact.; las horas reusan el resultado cacheado.
     */
    _indPredictionCache = new Map();
    _indPredictionInFlight = new Set();
    _indPrefetchTimer = null;
    _indPrefetchVersion = 0;
    /** Parametros del objeto operativo (fallbacks por defecto hasta prefetch). */
    uiMaxPinnedTickets = 5;
    uiStripWindowDays = 14;
    uiDayHighlightHours = 8;

    get maxPinnedLimit() {
        const n = Number(this.uiMaxPinnedTickets);
        return Number.isFinite(n) && n > 0 ? Math.min(99, Math.floor(n)) : 5;
    }

    get stripWindowSpan() {
        const n = Number(this.uiStripWindowDays);
        const configured = Number.isFinite(n) && n > 0 ? Math.min(STRIP_WINDOW_MAX, Math.floor(n)) : STRIP_WINDOW_FALLBACK;
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        return Math.max(1, Math.min(configured, daysInMonth));
    }

    get stripWindowMaxStartDay() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        return Math.max(1, last - this.stripWindowSpan + 1);
    }

    get stripVisibleRangeLabel() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        const start = this.stripWindowEffectiveStartDay;
        const end = Math.min(last, start + this.stripWindowSpan - 1);
        return `Días ${start}–${end} de ${MONTH_NAMES[m]}`;
    }

    get dayHoursHighlightThreshold() {
        const n = Number(this.uiDayHighlightHours);
        return Number.isFinite(n) && n > 0 ? Math.min(24, n) : DAY_HIGH_HOURS_HINT_DEFAULT;
    }

    /** Tamano pagina tickets desde settings (1–500; defecto 200). */
    get effectiveTicketPageSize() {
        const p = Number(this.imputationCenterSettings?.operativeTicketPageSize);
        if (Number.isFinite(p) && p >= 1 && p <= 500) return Math.floor(p);
        return 200;
    }

    /** Umbral aviso «muchas horas el mismo dia» (objeto operativo; defecto 10). */
    get effectiveHighDayHoursWarn() {
        const p = Number(this.imputationCenterSettings?.operativeWarnDayHours);
        if (Number.isFinite(p) && p > 0 && p <= 24) return p;
        return 10;
    }

    /** Meta % facturable desde registro operativo; si falta en org/FLS, default codigo 85 %. */
    get facturableTargetPctForUi() {
        const p = Number(this.imputationCenterSettings?.monthlyFacturableTargetPct);
        if (Number.isFinite(p) && p > 0 && p <= 100) return p;
        return FACTURABLE_TARGET_PCT_CODE;
    }

    /** Jornada meta (Horas_Meta_Dia_Lab); si falta, default 8 h (no 0). */
    get effectiveWorkdayTargetHours() {
        const p = Number(this.imputationCenterSettings?.workdayTargetHours);
        if (Number.isFinite(p) && p > 0 && p <= 24) return p;
        return JORNADA_OBJETIVO_HORAS;
    }

    get imputationAllowedMonthsRetro() {
        const p = Number(this.imputationCenterSettings?.imputationMonthsRetro);
        if (!Number.isFinite(p) || p < 0) return 0;
        return Math.min(120, Math.floor(p));
    }

    get imputationAllowedMonthsForward() {
        const p = Number(this.imputationCenterSettings?.imputationMonthsForward);
        if (!Number.isFinite(p) || p < 0) return 0;
        return Math.min(120, Math.floor(p));
    }

    get showExportCsvButton() {
        return this.imputationCenterSettings?.uiHideExportCsv !== true;
    }

    get showImportCsvButton() {
        return this.imputationCenterSettings?.uiHideImportCsv !== true;
    }

    /** Menú CSV visible si al menos importar o exportar están habilitados. */
    get showImportExportMenu() {
        return this.showImportCsvButton || this.showExportCsvButton;
    }

    handleImportExportMenuSelect(event) {
        const action = event.detail?.value;
        if (action === 'export') {
            this.exportImputations();
        } else if (action === 'import') {
            this.openImportModal();
        }
    }

    get showQuarterFacturablePanel() {
        return this.imputationCenterSettings?.uiHideQuarterPanel !== true;
    }

    get helpBannerText() {
        const t = this.imputationCenterSettings?.helpBannerText;
        return t && String(t).trim() ? String(t).trim() : '';
    }

    get showUsageGuideButton() {
        return this.imputationCenterSettings?.showUsageGuide !== false;
    }

    get usageGuideModel() {
        return buildUsageGuideModel({
            usageGuideIntro: this.imputationCenterSettings?.usageGuideIntro
        });
    }

    /** Colores de grafico resueltos (hex) para estilos inline; var() en conic-gradient no siempre hereda en LWC. */
    get resolvedChartColors() {
        return resolveChartColorsFromSettings(this.imputationCenterSettings);
    }

    get pandoraWrapperClass() {
        const base = 'pandora-wrapper slds-is-relative';
        return this.operativeThemeReady ? `${base} cc-operative-theme-active` : base;
    }

    get chartSwatchFactStyle() {
        return `background:${this.resolvedChartColors.fact};`;
    }

    get chartSwatchNoFactStyle() {
        return `background:${this.resolvedChartColors.noFact};`;
    }

    get usageGuidePointRows() {
        return (this.usageGuideModel?.points || []).map((p) => {
            const legendItems = p.legendItems || [];
            return {
                ...p,
                key: p.key,
                hasLegend: legendItems.length > 0,
                legendRows: legendItems.map((leg) => ({ ...leg, key: leg.key }))
            };
        });
    }

    openUsageGuideModal() {
        this.usageGuideModalOpen = true;
    }

    closeUsageGuideModal() {
        this.usageGuideModalOpen = false;
    }

    get headerCenterTagline() {
        const t = this.imputationCenterSettings?.headerCenterTagline;
        return t && String(t).trim() ? String(t).trim() : '';
    }

    get imputationExceptionDateSet() {
        const raw = this.imputationCenterSettings?.imputationExceptionDates;
        const set = new Set();
        if (!raw || typeof raw !== 'string') {
            return set;
        }
        for (const token of raw.split(/[\s,;]+/)) {
            const t = String(token || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
                set.add(t);
            }
        }
        return set;
    }

    isImputationExceptionDate(isoDate) {
        return isoDate && this.imputationExceptionDateSet.has(isoDate);
    }

    get defaultImputationSource() {
        const s = this.imputationCenterSettings?.operativeDefaultSource;
        return s && String(s).trim() ? String(s).trim() : 'MassiveLWC';
    }

    get allowWeekendImputation() {
        if (this.imputationCenterSettings?.allowWeekendImputation !== false) {
            return true;
        }
        return this.imputationCenterSettings?.userWeekendImputationBypass === true;
    }

    get allowHolidayImputation() {
        return this.imputationCenterSettings?.allowHolidayImputation !== false;
    }

    /** Pestaña activa en el modal Monitor (`calc` | `info`). */
    monitorModalTab = 'calc';

    quickComments = [
        { label: 'Analisis funcional', value: 'Analisis funcional AMS' },
        { label: 'Soporte correctivo', value: 'Soporte correctivo / ajuste menor' },
        { label: 'Configuracion', value: 'Configuracion y parametrizacion' },
        { label: 'Reunion cliente', value: 'Reunion de seguimiento con cliente' }
    ];
    hourPresets = [0.5, 1, 2, 4, 8];

    connectedCallback() {
        this.restoreStoredPreferences();
        this.entryDate = this.todayLocalISODate();
        this.selectedDates = [this.entryDate];
        this.syncCalendarMonthToEntry();
        this.restoreLastCommentFromStorage();
        this.restoreBulkPanelOpen();
        this.restorePinnedTickets();
        window.addEventListener('keydown', this.boundImportEscape);
        window.addEventListener('mouseup', this.boundCalendarMouseUp);
        document.addEventListener('visibilitychange', this.boundVisibilityRefresh);
        this.bootstrap();
    }

    /** Clave de localStorage para anclar tickets por usuario y por pestaña (mine/ams). */
    get pinnedStorageKey() {
        const uid = currentUserId || 'anon';
        const tab = this.ticketTabSource || 'mine';
        return `${PINNED_STORAGE_PREFIX}.${uid}.${tab}`;
    }

    restorePinnedTickets() {
        try {
            const raw = window.localStorage?.getItem(this.pinnedStorageKey);
            if (!raw) {
                this.pinnedTicketIds = [];
                return;
            }
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.pinnedTicketIds = parsed
                    .filter((v) => typeof v === 'string' && v)
                    .slice(0, this.maxPinnedLimit);
            }
        } catch (e) {
            this.pinnedTicketIds = [];
        }
    }

    persistPinnedTickets() {
        try {
            window.localStorage?.setItem(
                this.pinnedStorageKey,
                JSON.stringify(this.pinnedTicketIds || [])
            );
        } catch (e) {
            /* Locker / privado */
        }
    }

    /** True si el caseId está actualmente anclado. */
    isCasePinned(caseId) {
        return Array.isArray(this.pinnedTicketIds) && this.pinnedTicketIds.includes(caseId);
    }

    handleTogglePin(event) {
        const caseId =
            event && event.currentTarget && event.currentTarget.dataset
                ? event.currentTarget.dataset.rowId
                : null;
        if (!caseId) return;

        const current = Array.isArray(this.pinnedTicketIds) ? [...this.pinnedTicketIds] : [];
        const idx = current.indexOf(caseId);

        if (idx >= 0) {
            current.splice(idx, 1);
            this.pinnedTicketIds = current;
            this.persistPinnedTickets();
            return;
        }

        if (current.length >= this.maxPinnedLimit) {
            this.toast(
                'No se pueden anclar más tickets',
                `Solo puedes anclar hasta ${this.maxPinnedLimit} tickets a la vez. Desancla alguno antes de añadir otro.`,
                'warning'
            );
            return;
        }
        current.push(caseId);
        this.pinnedTicketIds = current;
        this.persistPinnedTickets();
    }

    restoreStoredPreferences() {
        try {
            const ct = window.localStorage?.getItem(STORAGE_CHART_TYPE);
            const ctNorm = ct ? String(ct).trim().toLowerCase() : '';
            if (ctNorm && CHART_TYPES.has(ctNorm)) {
                this.monthlyChartType = ctNorm;
            }
            const sb = window.localStorage?.getItem(STORAGE_SIDEBAR_CALENDAR);
            this.preferenceSidebarCalendar = sb === '1';
        } catch (e) {
            /* Locker / privado */
        }
    }

    monthYmWithOffset(year, monthIndex0, deltaMonths) {
        const d = new Date(year, monthIndex0 + deltaMonths, 1);
        const m = d.getMonth() + 1;
        return `${d.getFullYear()}-${m < 10 ? '0' : ''}${m}`;
    }

    get monthPickerValue() {
        const y = this.calendarMonthDate.getFullYear();
        const m = String(this.calendarMonthDate.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    }

    disconnectedCallback() {
        window.removeEventListener('keydown', this.boundImportEscape);
        window.removeEventListener('mouseup', this.boundCalendarMouseUp);
        document.removeEventListener('visibilitychange', this.boundVisibilityRefresh);
        if (this._hoursPatchTimers) {
            Object.values(this._hoursPatchTimers).forEach((t) => clearTimeout(t));
            this._hoursPatchTimers = {};
            this._hoursPatchValues = {};
        }
        if (this._indPrefetchTimer) {
            clearTimeout(this._indPrefetchTimer);
            this._indPrefetchTimer = null;
        }
    }

    boundVisibilityRefresh = () => {
        if (document.visibilityState !== 'visible' || this.isLoading) {
            return;
        }
        this.prefetchImputationCenterSettings().catch(() => {});
    };

    boundCalendarMouseUp = () => {
        const hadStripDrag = this.isCalendarDragSelecting;
        const hadRowDrag = this.rowDateIsDragging;
        this.isCalendarDragSelecting = false;
        this.calendarDragAnchorIso = null;
        this.rowDateIsDragging = false;
        this.rowDateDragAnchorIso = null;
        if (hadStripDrag) {
            this.buildCalendar();
            this.ensureMonthHoursMatchEntryMonth().catch(() => {});
        }
        if (hadRowDrag) {
            /* Getter rowDateCalendarDays se actualiza con rowDateSelectedDates; solo limpiamos arrastre. */
        }
    };

    composedPathIncludesStripDayTarget(event) {
        const raw = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const path = raw.length ? raw : [event.target];
        return path.some((node) => {
            if (!node || node.nodeType !== 1) {
                return false;
            }
            if (typeof node.matches === 'function') {
                if (
                    node.matches('button.strip-day-btn') ||
                    node.matches('.strip-day-btn') ||
                    node.matches('button.strip-day-detail-btn') ||
                    node.matches('.strip-day-detail-btn')
                ) {
                    return true;
                }
            }
            const tag = node.tagName;
            if (tag === 'LIGHTNING-BUTTON-ICON') {
                return true;
            }
            return false;
        });
    }

    composedPathIncludesCalendarDayTarget(event) {
        const raw = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const path = raw.length ? raw : [event.target];
        return path.some((node) => {
            if (!node || node.nodeType !== 1) return false;
            if (typeof node.matches === 'function') {
                if (node.matches('button.cal-day') || node.matches('button.cal-day-detail-btn')) {
                    return true;
                }
            }
            return false;
        });
    }

    restoreBulkPanelOpen() {
        try {
            if (window.localStorage?.getItem(STORAGE_BULK_PANEL) === '1') {
                this.bulkPanelOpen = true;
            }
        } catch (e) {
            /* ignore */
        }
    }

    persistBulkPanelOpen() {
        try {
            window.localStorage?.setItem(STORAGE_BULK_PANEL, this.bulkPanelOpen ? '1' : '0');
        } catch (e) {
            /* ignore */
        }
    }

    restoreLastCommentFromStorage() {
        try {
            const v = window.localStorage?.getItem(STORAGE_LAST_COMMENT);
            if (v != null && String(v).trim() !== '') {
                this.comment = v;
            }
        } catch (e) {
            /* Locker / modo privado: ignorar */
        }
    }

    /** Devuelve el texto a reusar tras guardar OK y lo persiste en localStorage si no está vacío. */
    persistLastCommentAfterSuccessfulSave(selectedRowsData) {
        let toStore = this.comment != null ? String(this.comment).trim() : '';
        if (!toStore && selectedRowsData?.length) {
            const uniq = [...new Set(selectedRowsData.map((r) => (r.plannedComment || '').trim()).filter(Boolean))];
            if (uniq.length === 1) {
                toStore = uniq[0];
            }
        }
        try {
            if (toStore) {
                window.localStorage?.setItem(STORAGE_LAST_COMMENT, toStore);
            }
        } catch (e) {
            /* ignore */
        }
        return toStore;
    }

    buildSaveToastMessage(ok, failed, datesIso) {
        if (ok <= 0 && failed <= 0) {
            return 'No se crearon registros. Si el problema continúa, vuelve a intentarlo o contacta con soporte.';
        }
        if (!ok && failed > 0) {
            return 'Ningún registro se guardó. Revisa el mensaje en rojo junto a cada ticket y corrige los datos.';
        }
        if (failed > 0) {
            return `Se guardaron ${ok} registro(s); ${failed} no se pudieron guardar. Corrige los tickets marcados con error e inténtalo de nuevo.`;
        }
        const unique = [...new Set((datesIso || []).filter(Boolean))].sort();
        let msg = `Se guardaron correctamente ${ok} registro(s) de tiempo.`;
        if (unique.length > 1) {
            const sample = unique
                .slice(0, 4)
                .map((d) => this.formatDMY(d))
                .join(', ');
            const ellipsis = unique.length > 4 ? '…' : '';
            msg += ` Se aplicaron las mismas horas en ${unique.length} días (${sample}${ellipsis}).`;
        } else if (unique.length === 1) {
            msg += ` Día: ${this.formatDMY(unique[0])}.`;
        }
        if (unique.length > 1) {
            msg += ' Comprueba en el calendario que esas fechas son las que necesitas.';
        }
        return msg;
    }

    clearSearchFilter() {
        this.searchTerm = '';
    }

    /** Fecha local del navegador (evita desfase UTC de toISOString). */
    todayLocalISODate() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    async bootstrap() {
        this.loadingStatusText = 'Cargando pantalla…';
        this.isLoading = true;
        try {
            await this.loadUiOptions();
            await this.prefetchImputationCenterSettings();
            if (this.showCatalogTabCreatedFilter) {
                this.ensureAmsCreatedFilterDefault();
            }
            await this.loadMonthHours({ nesting: true });
            await this.loadTickets({ silent: true, nesting: true });
            this.loadCurrentYearQuarterFacturable({ nesting: true }).catch(() => {});
        } finally {
            this.isLoading = false;
        }
    }

    syncCalendarMonthToEntry() {
        if (!this.entryDate) {
            this.calendarMonthDate = new Date(this.calendarMonthDate.getFullYear(), this.calendarMonthDate.getMonth(), 1);
            return;
        }
        const p = this.entryDate.split('-').map((x) => parseInt(x, 10));
        if (p.length === 3 && p.every((n) => !Number.isNaN(n))) {
            this.calendarMonthDate = new Date(p[0], p[1] - 1, 1);
        }
    }

    /**
     * Fecha imputable para guardar o seleccionar en calendario (no admin).
     * Mes en curso siempre; ventana retro/adelante amplia otros meses; VAC permite fechas futuras en meses posteriores.
     */
    isIsoImputable(iso, options) {
        const allowFutureDates =
            (options && options.allowFutureDates === true) || this.hasSelectedFutureFriendlyRow;
        return isConsultantImputationDateAllowed(iso, {
            isAdmin: this.isImputationAdmin,
            todayIso: this.todayLocalISODate(),
            monthsRetro: this.imputationAllowedMonthsRetro,
            monthsForward: this.imputationAllowedMonthsForward,
            allowFutureDates
        });
    }

    /** True si al menos una fila seleccionada permite imputar a futuro (ej. VAC). */
    get hasSelectedFutureFriendlyRow() {
        const sel = new Set(this.selectedRows || []);
        if (!sel.size) return false;
        for (const r of this.rows || []) {
            if (sel.has(r.caseId) && r.allowsFutureDates === true) return true;
        }
        return false;
    }

    calendarMonthKey() {
        return `${this.calendarMonthDate.getFullYear()}-${this.calendarMonthDate.getMonth()}`;
    }

    /**
     * Aviso de muchas horas el mismo día solo al intento de guardar (confirmar imputación), no al elegir día.
     */
    toastHeavyDaysIfSaving(entriesDatesIsoSet) {
        if (this.imputationCenterSettings?.activarAvisoUmbralHoras === false) {
            return;
        }
        const heavy = [...entriesDatesIsoSet].filter((d) => typeof d === 'string' && d.length >= 10);
        if (!heavy.length) {
            return;
        }
        const lines = [];
        const warnH = this.effectiveHighDayHoursWarn;
        heavy.forEach((d) => {
            const h = Number(this.dailyHoursByDate[d]) || 0;
            if (h > warnH) {
                lines.push(`${this.formatDMY(d)} (${this.stripHoursSubtitle(h)} ya cargadas)`);
            }
        });
        if (!lines.length) {
            return;
        }
        const detalle = lines.join('; ');
        const tpl =
            (this.imputationCenterSettings?.thresholdHoursWarnText || '').trim() ||
            'Vas a sumar tiempo en día(s) que ya superan las {horas} h: {detalle}. Comprueba que no estés cargando el mismo trabajo dos veces.';
        const message = tpl.replace(/\{horas\}/gi, String(warnH)).replace(/\{detalle\}/gi, detalle);
        this.toast('Muchas horas en un mismo día', message, 'warning');
    }

    /** Tras elegir fecha: recarga horas diarias si el mes de trabajo no coincide con el mes ya cargado. */
    async ensureMonthHoursMatchEntryMonth() {
        const ed = this.entryDate;
        if (!ed) {
            return;
        }
        const p = ed.split('-').map((x) => parseInt(x, 10));
        if (p.length !== 3 || p.some((n) => Number.isNaN(n))) {
            return;
        }
        const wantKey = `${p[0]}-${p[1] - 1}`;
        if (wantKey === this.calendarMonthKey()) {
            this.buildCalendar();
            return;
        }
        this.calendarMonthDate = new Date(p[0], p[1] - 1, 1);
        this.loadingStatusText = 'Cargando calendario…';
        this.isLoading = true;
        try {
            await this.loadMonthHours({ nesting: true });
        } finally {
            this.isLoading = false;
        }
    }

    formatDMY(iso) {
        if (!iso) return '';
        const [y, m, d] = iso.split('-');
        return `${d}/${m}/${y}`;
    }

    get currentMonthName() {
        return MONTH_NAMES[this.calendarMonthDate.getMonth()];
    }

    get currentYear() {
        return this.calendarMonthDate.getFullYear();
    }

    get datesForSave() {
        const sorted = [...this.selectedDates]
            .filter((d) => typeof d === 'string' && d.length >= 8)
            .sort();
        if (sorted.length) {
            return sorted;
        }
        const anchor = this.entryDate;
        return anchor ? [anchor] : [];
    }

    getRowDatesForSave(row, fallbackDates) {
        const rowDates = Array.isArray(row?._rowDates) ? row._rowDates.filter(Boolean) : [];
        if (rowDates.length) return [...new Set(rowDates)].sort();
        if (row?._importFecha) return [row._importFecha];
        return fallbackDates && fallbackDates.length ? fallbackDates : [];
    }

    async navigateCalendarMonth(delta, options = {}) {
        if (this.isLoading) {
            return;
        }
        this.calendarMonthDate = new Date(
            this.calendarMonthDate.getFullYear(),
            this.calendarMonthDate.getMonth() + delta,
            1
        );
        const today = new Date();
        const targetIsCurrentMonth =
            today.getFullYear() === this.calendarMonthDate.getFullYear() &&
            today.getMonth() === this.calendarMonthDate.getMonth();
        const anchor = options && options.windowAnchor;
        if (targetIsCurrentMonth) {
            /* Al volver al mes en curso siempre reanclamos a «hoy». */
            this.stripWindowStartDay = null;
        } else if (anchor === 'end') {
            const lastDay = new Date(
                this.calendarMonthDate.getFullYear(),
                this.calendarMonthDate.getMonth() + 1,
                0
            ).getDate();
            this.stripWindowStartDay = Math.max(1, lastDay - this.stripWindowSpan + 1);
        } else if (anchor === 'start') {
            this.stripWindowStartDay = 1;
        } else {
            this.stripWindowStartDay = null;
        }
        this.normalizeStripWindowForCurrentMonth();
        this.buildCalendar();
        this.loadingStatusText = 'Cargando calendario…';
        this.isLoading = true;
        try {
            await this.loadMonthHours({ nesting: true });
        } finally {
            this.isLoading = false;
        }
    }

    handlePrevMonth() {
        return this.navigateCalendarMonth(-1);
    }

    handleNextMonth() {
        return this.navigateCalendarMonth(1);
    }

    fillIsoDateRangeInclusive(isoA, isoB) {
        if (!isoA || !isoB) return [];
        const dA = this.parseIsoDate(isoA);
        const dB = this.parseIsoDate(isoB);
        const tA = dA.getTime();
        const tB = dB.getTime();
        const start = tA <= tB ? dA : dB;
        const end = tA <= tB ? dB : dA;
        const out = [];
        const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endTime = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
        while (cur.getTime() <= endTime) {
            const iso = this.formatDateForCalendar(cur);
            if (this.isIsoImputable(iso)) {
                out.push(iso);
            }
            cur.setDate(cur.getDate() + 1);
        }
        return out;
    }

    applyDragDateRange(anchorIso, currentIso) {
        if (!anchorIso || !currentIso) return;
        const range = this.fillIsoDateRangeInclusive(anchorIso, currentIso);
        if (!range.length) {
            return;
        }
        this.selectedDates = range;
        this.entryDate = currentIso;
        this.invalidatePendingBillableBreakdown();
    }

    /** Mensaje genérico cuando una fecha del calendario/strip global no es imputable. */
    globalDateNotAllowedMessage() {
        if (this.isImputationAdmin) {
            return 'No se pudo aplicar esa fecha. Elige otra en el calendario.';
        }
        if (this.hasSelectedFutureFriendlyRow) {
            return 'En vacaciones puedes elegir el mes en curso o fechas futuras, pero no meses anteriores.';
        }
        return 'Solo puedes registrar horas en el mes actual. Si necesitas otro mes, contacta con tu responsable.';
    }

    selectSingleDate(iso) {
        if (!iso) return;
        if (!this.isIsoImputable(iso)) {
            this.toast('Fecha no disponible', this.globalDateNotAllowedMessage(), 'warning');
            return;
        }
        this.entryDate = iso;
        this.selectedDates = [iso];
        this.invalidatePendingBillableBreakdown();
    }

    toggleDateInSelection(iso) {
        if (!iso) return;
        if (!this.isIsoImputable(iso)) {
            this.toast('Fecha no disponible', this.globalDateNotAllowedMessage(), 'warning');
            return;
        }
        const idx = this.selectedDates.indexOf(iso);
        if (idx >= 0) {
            const next = this.selectedDates.filter((d) => d !== iso).sort();
            this.selectedDates = next;
            this.entryDate = next.length ? next[next.length - 1] : undefined;
        } else {
            this.selectedDates = [...this.selectedDates, iso].sort();
            this.entryDate = iso;
        }
        this.invalidatePendingBillableBreakdown();
    }

    handleDayMouseDown(event) {
        if (event.button !== 0) return;
        if (event.ctrlKey || event.metaKey) {
            return;
        }
        event.preventDefault();
        const iso = event.currentTarget.dataset.date;
        if (!this.isIsoImputable(iso)) {
            return;
        }
        this.isCalendarDragSelecting = true;
        this.suppressNextDayClick = true;
        this.calendarDragAnchorIso = iso;
        this.applyDragDateRange(iso, iso);
        this.buildCalendar();
    }

    handleDayMouseEnter(event) {
        if (!this.isCalendarDragSelecting || !this.calendarDragAnchorIso) return;
        const iso = event.currentTarget.dataset.date;
        if (!this.isIsoImputable(iso)) {
            return;
        }
        this.applyDragDateRange(this.calendarDragAnchorIso, iso);
        this.buildCalendar();
    }

    handleDayClick(event) {
        if (this.suppressNextDayClick) {
            this.suppressNextDayClick = false;
            return;
        }
        const iso = event.currentTarget.dataset.date;
        if (!iso) return;
        if (event.ctrlKey || event.metaKey) {
            this.toggleDateInSelection(iso);
        } else {
            this.selectSingleDate(iso);
        }
        this.isCalendarDragSelecting = false;
        this.calendarDragAnchorIso = null;
        this.buildCalendar();
        this.ensureMonthHoursMatchEntryMonth().catch(() => {});
    }

    openImputationCenterSettingsModal() {
        const r = openImputationCenterMonitorModal(this.isImputationAdmin);
        if (!r.apply) {
            return;
        }
        this.monitorModalTab = r.monitorModalTab;
        this.imputationCenterSettingsOpen = r.imputationCenterSettingsOpen;
        /* Actualiza lectura CMDT solo para avisos de discrepancia en el panel (opcional). */
        this.prefetchImputationCenterSettings().then(() => {
            this.loadMonthHours({ nesting: true }).catch(() => {});
        });
    }

    handleMonitorTabActive(event) {
        const v = tabValueFromMonitorActiveEvent(event);
        if (v) {
            this.monitorModalTab = v;
        }
    }

    closeImputationCenterSettingsModal() {
        this.imputationCenterSettingsOpen = false;
    }

    handleStripPrevMonth() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        const start = this.stripWindowEffectiveStartDay;
        if (start > 1) {
            const next = Math.max(1, start - this.stripWindowSpan);
            const maxStart = Math.max(1, last - this.stripWindowSpan + 1);
            this.stripWindowStartDay = Math.min(next, maxStart);
            return;
        }
        return this.navigateCalendarMonth(-1, { windowAnchor: 'end' });
    }

    handleStripNextMonth() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        const start = this.stripWindowEffectiveStartDay;
        const end = Math.min(last, start + this.stripWindowSpan - 1);
        if (end < last) {
            const next = Math.min(Math.max(1, last - this.stripWindowSpan + 1), start + this.stripWindowSpan);
            this.stripWindowStartDay = next;
            return;
        }
        return this.navigateCalendarMonth(1, { windowAnchor: 'start' });
    }

    async handleMonthPickerChange(event) {
        const value = event.target?.value;
        if (!value || !/^\d{4}-\d{2}$/.test(value)) return;
        const [y, m] = value.split('-').map((n) => parseInt(n, 10));
        if (!Number.isFinite(y) || !Number.isFinite(m)) return;
        this.calendarMonthDate = new Date(y, m - 1, 1);
        this.stripWindowStartDay = null;
        this.normalizeStripWindowForCurrentMonth();
        this.buildCalendar();
        this.loadingStatusText = 'Cargando calendario…';
        this.isLoading = true;
        try {
            await this.loadMonthHours({ nesting: true });
        } finally {
            this.isLoading = false;
        }
    }

    handleStripDayMouseDown(event) {
        if (event.button !== 0) return;
        if (event.ctrlKey || event.metaKey) {
            return;
        }
        event.preventDefault();
        const iso = event.currentTarget.dataset.date;
        if (!iso) return;
        if (!this.isIsoImputable(iso)) {
            return;
        }
        this.isCalendarDragSelecting = true;
        this.suppressNextDayClick = true;
        this.calendarDragAnchorIso = iso;
        this.applyDragDateRange(iso, iso);
        this.syncCalendarMonthToEntry();
        this.buildCalendar();
    }

    handleStripDayMouseEnter(event) {
        if (!this.isCalendarDragSelecting || !this.calendarDragAnchorIso) return;
        const iso = event.currentTarget.dataset.date;
        if (!iso) return;
        if (!this.isIsoImputable(iso)) {
            return;
        }
        this.applyDragDateRange(this.calendarDragAnchorIso, iso);
        this.syncCalendarMonthToEntry();
        this.buildCalendar();
    }

    async handleStripDayClick(event) {
        if (this.suppressNextDayClick) {
            this.suppressNextDayClick = false;
            return;
        }
        const iso = event.currentTarget.dataset.date;
        if (!iso) return;
        if (event.ctrlKey || event.metaKey) {
            this.toggleDateInSelection(iso);
        } else {
            this.selectSingleDate(iso);
        }
        this.isCalendarDragSelecting = false;
        this.calendarDragAnchorIso = null;
        this.syncCalendarMonthToEntry();
        this.buildCalendar();
        await this.ensureMonthHoursMatchEntryMonth();
    }

    /** Clic fuera de los botones día (huecos del grid/padding): quitamos el resaltado azul. */
    clearGlobalDaySelection() {
        this.entryDate = undefined;
        this.selectedDates = [];
        this.calendarDragAnchorIso = null;
        this.invalidatePendingBillableBreakdown();
    }

    /** Fila completa del strip (incl. márgenes): clic fuera de días y flechas deselecciona. */
    handleStripNavRowMouseDown(event) {
        if (!this.isQuickActionMode || event.button !== 0) {
            return;
        }
        if (this.composedPathIncludesStripDayTarget(event)) {
            return;
        }
        this.clearGlobalDaySelection();
        this.isCalendarDragSelecting = false;
        this.suppressNextDayClick = false;
        this.buildCalendar();
    }

    handleCalDaysSurfaceMouseDown(event) {
        if (event.button !== 0) {
            return;
        }
        if (this.composedPathIncludesCalendarDayTarget(event)) {
            return;
        }
        this.clearGlobalDaySelection();
        this.isCalendarDragSelecting = false;
        this.suppressNextDayClick = false;
        this.buildCalendar();
    }

    closeDayDetailModal() {
        this.dayDetailModalOpen = false;
        this.dayDetailIso = '';
        this.dayDetailLines = [];
        this.dayDetailLoading = false;
        this.closeDayEditModal();
    }

    mapBreakdownLinesFromParsed(parsed) {
        return (parsed || []).map((row, i) => {
            let factLabel = '—';
            if (row.noFacturable === true) {
                factLabel = 'No fact.';
            } else if (row.noFacturable === false) {
                factLabel = 'Fact.';
            }
            const impId = row.imputationId || row.ImputationId;
            const canEdit = row.canEdit === true;
            const hasImpId = !!(impId && String(impId).length >= 15);
            return {
                ...row,
                imputationId: impId,
                key: impId ? String(impId) : String(row.caseId != null ? row.caseId : `row-${i}`),
                hoursLabel: this.formatHoursShort(row.hours),
                factLabel,
                caseRecordUrl:
                    row.caseId != null && String(row.caseId).length >= 15
                        ? `/lightning/r/Case/${row.caseId}/view`
                        : null,
                impRecordUrl: impId != null ? `/lightning/r/Imputacion__c/${impId}/view` : null,
                canEdit,
                showDeleteImp: hasImpId && canEdit,
                showDayDetailEdit: hasImpId && canEdit,
                comment: row.comment || ''
            };
        });
    }

    openDayDetailEdit(event) {
        event.preventDefault();
        event.stopPropagation();
        const impId = event.currentTarget?.dataset?.impId;
        if (!impId) {
            return;
        }
        const line = (this.dayDetailLines || []).find((l) => String(l.imputationId) === String(impId));
        if (!line) {
            return;
        }
        this.dayEditImputationId = impId;
        const h = Number(line.hours);
        this.dayEditHoursStr = Number.isFinite(h) && h > 0 ? String(h) : '';
        this.dayEditIsoDate = this.dayDetailIso || '';
        this.dayEditNoFacturable = line.noFacturable === true;
        this.dayEditComment = line.comment != null ? String(line.comment) : '';
        this.dayEditModalOpen = true;
    }

    closeDayEditModal() {
        this.dayEditModalOpen = false;
        this.dayEditImputationId = null;
        this.dayEditHoursStr = '';
        this.dayEditIsoDate = '';
        this.dayEditNoFacturable = false;
        this.dayEditComment = '';
        this.dayEditSaving = false;
    }

    handleDayEditHoursChange(event) {
        this.dayEditHoursStr = event.detail.value;
    }

    handleDayEditDateChange(event) {
        this.dayEditIsoDate = event.detail.value;
    }

    handleDayEditNfChange(event) {
        this.dayEditNoFacturable = !!event.detail.checked;
    }

    handleDayEditCommentChange(event) {
        this.dayEditComment = event.detail.value;
    }

    async saveDayEditModal() {
        const impId = this.dayEditImputationId;
        if (!impId) {
            return;
        }
        const parsed = parseFloat(this.dayEditHoursStr);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            this.toast('Atención', 'Las horas deben ser mayores que cero.', 'warning');
            return;
        }
        if (parsed > 24) {
            this.toast('Atención', 'Las horas no pueden superar 24.', 'warning');
            return;
        }
        const iso = this.dayEditIsoDate;
        if (!iso || typeof iso !== 'string' || iso.length < 10) {
            this.toast('Atención', 'Indica una fecha válida.', 'warning');
            return;
        }
        if (!this.isImputationAdmin && !this.isIsoImputable(iso)) {
            this.toast('Atención', 'Solo puedes guardar en el mes en curso.', 'warning');
            return;
        }

        const payload = {
            imputationId: impId,
            hours: parsed,
            entryDateIso: iso.slice(0, 10),
            noFacturable: this.dayEditNoFacturable,
            comment: this.dayEditComment != null ? String(this.dayEditComment).slice(0, 255) : ''
        };

        this.dayEditSaving = true;
        try {
            const raw = await updateImputationRecord({ payloadJson: JSON.stringify(payload) });
            const resp = JSON.parse(raw || '{}');
            if (!resp.success) {
                this.toast('No se guardó', resp.message || 'Error al actualizar.', 'error');
                return;
            }
            this.toast('Guardado', 'Imputación actualizada.', 'success');
            this.closeDayEditModal();
            const dayIso = this.dayDetailIso;
            if (dayIso) {
                await this.handleDayDetailBreakdownClickRefresh(dayIso);
            }
            await this.loadMonthHours({ nesting: true });
            await this.loadTickets({ silent: true, nesting: true });
            this.buildCalendar();
        } catch (e) {
            this.toast('Error', this.normalizeError(e), 'error');
        } finally {
            this.dayEditSaving = false;
        }
    }

    async handleDayDetailBreakdownClick(event) {
        event.stopPropagation();
        event.preventDefault();
        const iso = event.currentTarget?.dataset?.date;
        if (!iso) {
            return;
        }
        this.dayDetailModalOpen = true;
        this.dayDetailIso = iso;
        this.dayDetailLines = [];
        this.dayDetailLoading = true;
        try {
            const consultantUserId = this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : null;
            const raw = await getTicketHoursBreakdownForDay({
                isoDate: iso,
                consultantUserId
            });
            const parsed = JSON.parse(raw || '[]');
            this.dayDetailLines = this.mapBreakdownLinesFromParsed(parsed);
        } catch (e) {
            this.dayDetailLines = [];
            this.toast('Error', 'No se pudo cargar el detalle de tickets de ese día.', 'error');
        } finally {
            this.dayDetailLoading = false;
        }
    }

    get dayDetailModalTitle() {
        return this.dayDetailIso ? `Imputaciones el ${this.formatDMY(this.dayDetailIso)}` : 'Detalle del día';
    }

    get dayDetailTotalLabel() {
        const t = (this.dayDetailLines || []).reduce((s, r) => s + (Number(r.hours) || 0), 0);
        return this.formatHoursShort(t);
    }

    async handleDayDetailDeleteLine(event) {
        event.preventDefault();
        event.stopPropagation();
        const impId = event.currentTarget?.dataset?.impId;
        if (!impId) {
            return;
        }
        this.dayDetailLoading = true;
        try {
            const raw = await deleteImputationRecord({ imputationId: impId });
            const resp = JSON.parse(raw || '{}');
            if (!resp.success) {
                this.toast('No se eliminó', resp.message || 'Error al borrar.', 'error');
                return;
            }
            this.toast('Listo', 'Imputación eliminada.', 'success');
            const iso = this.dayDetailIso;
            if (iso) {
                await this.handleDayDetailBreakdownClickRefresh(iso);
            }
            await this.loadMonthHours({ nesting: true });
            this.buildCalendar();
        } catch (e) {
            this.toast('Error', this.normalizeError(e), 'error');
        } finally {
            this.dayDetailLoading = false;
        }
    }

    openImputationRecord(event) {
        event.preventDefault();
        event.stopPropagation();
        const u = event.currentTarget?.dataset?.url;
        if (u) {
            window.open(u, '_blank', 'noopener');
        }
    }

    async handleDayDetailBreakdownClickRefresh(iso) {
        this.dayDetailLoading = true;
        try {
            const consultantUserId = this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : null;
            const raw = await getTicketHoursBreakdownForDay({
                isoDate: iso,
                consultantUserId
            });
            const parsed = JSON.parse(raw || '[]');
            this.dayDetailLines = this.mapBreakdownLinesFromParsed(parsed);
        } catch (e) {
            this.dayDetailLines = [];
        } finally {
            this.dayDetailLoading = false;
        }
    }

    handleMonthlyChartTypePick(event) {
        event.preventDefault();
        event.stopPropagation();
        const raw = event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.chartType;
        const t = raw ? String(raw).trim().toLowerCase() : '';
        if (!t || !CHART_TYPES.has(t)) return;
        this.monthlyChartType = t;
        try {
            window.localStorage?.setItem(STORAGE_CHART_TYPE, t);
        } catch (e) {
            /* ignore */
        }
    }

    toggleLayoutSettingsPopover() {
        this.layoutSettingsOpen = !this.layoutSettingsOpen;
    }

    handlePreferenceSidebarCalendarChange(event) {
        this.preferenceSidebarCalendar = !!event.detail.checked;
        try {
            window.localStorage?.setItem(STORAGE_SIDEBAR_CALENDAR, this.preferenceSidebarCalendar ? '1' : '0');
        } catch (e) {
            /* ignore */
        }
        this.buildCalendar();
    }

    handleTicketCatalogTabClick(event) {
        const v = event.currentTarget?.dataset?.tabId;
        if (!v || !this.resolvedCatalogTabs.some((t) => t.id === v)) {
            return;
        }
        if (v === this.ticketTabSource) {
            return;
        }
        this.ticketTabSource = v;
        this.searchTerm = '';
        this.selectedRows = [];
        this.tableErrors = { rows: {} };
        this.restorePinnedTickets();
        if (this.showCatalogTabCreatedFilter) {
            this.ensureAmsCreatedFilterDefault();
        }
        const tab = this.activeCatalogTab;
        const silent = tab && (tab.type === 'ams' || tab.type === 'custom');
        return this.loadTickets({ silent, nesting: false });
    }

    get resolvedCatalogTabs() {
        let tabs = this.imputationCenterSettings?.ticketCatalogTabs;
        if (!Array.isArray(tabs) || !tabs.length) {
            tabs =
                this.imputationCenterSettings?.uiHideAmsTab === true
                    ? FALLBACK_CATALOG_TABS.filter((t) => t.id !== 'ams')
                    : FALLBACK_CATALOG_TABS;
        }
        return tabs.filter((t) => t && t.hidden !== true);
    }

    resolvePanelMetaText(kind, pct) {
        const raw = this.imputationCenterSettings?.panelMetaCopyJson;
        let copy = repairPanelMetaFromParsed({});
        try {
            const repaired = repairPanelMetaCopyJson(raw);
            const parsed = JSON.parse(repaired);
            if (parsed && typeof parsed === 'object') {
                copy = repairPanelMetaFromParsed(parsed);
            }
        } catch (e) {
            copy = repairPanelMetaFromParsed({});
        }
        const isBadge = kind === 'badge';
        const suffix = this.metaTierSuffix(pct);
        const key = (isBadge ? 'badge' : 'msg') + suffix;
        const text = copy[key];
        return text != null && String(text).trim() ? String(text).trim() : '';
    }

    /**
     * Devuelve el sufijo de tramo ('100' | '85' | '70' | '40' | '0') para resolver los
     * textos/badges/iconos configurados. El tramo '85' es el del BONO y se dispara al alcanzar
     * el % facturable configurado (bonoThresholdPct), no un 85 fijo. Los tramos intermedios se
     * acotan para no superar el bono y mantener el orden creciente aunque el bono sea bajo.
     */
    metaTierSuffix(pct) {
        const bono = this.bonoThresholdPct;
        const mid = Math.min(70, bono);
        const low = Math.min(40, mid);
        if (pct >= 100) return '100';
        if (pct >= bono) return '85';
        if (pct >= mid) return '70';
        if (pct >= low) return '40';
        return '0';
    }

    /** Tramos superados (0-4) hacia la meta, usando el bono dinámico. */
    metaTierFilled(pct) {
        const suffix = this.metaTierSuffix(pct);
        if (suffix === '100') return 4;
        if (suffix === '85') return 3;
        if (suffix === '70') return 2;
        if (suffix === '40') return 1;
        return 0;
    }

    resolvePanelMetaIcon(pct) {
        const raw = this.imputationCenterSettings?.panelMetaCopyJson;
        let copy = repairPanelMetaFromParsed({});
        try {
            const repaired = repairPanelMetaCopyJson(raw);
            const parsed = JSON.parse(repaired);
            if (parsed && typeof parsed === 'object') {
                copy = repairPanelMetaFromParsed(parsed);
            }
        } catch (e) {
            copy = repairPanelMetaFromParsed({});
        }
        const key = 'badgeIcon' + this.metaTierSuffix(pct);
        const icon = copy[key];
        return icon && String(icon).trim() ? normalizeSldsIconValue(icon) : 'utility:target';
    }

    get activeCatalogTab() {
        const tabs = this.resolvedCatalogTabs;
        const current = this.ticketTabSource || 'mine';
        return tabs.find((t) => t.id === current) || tabs[0];
    }

    get ticketCatalogTabButtons() {
        const current = this.ticketTabSource || 'mine';
        return this.resolvedCatalogTabs.map((t) => {
            const isSelected = t.id === current;
            return {
                id: t.id,
                label: t.label,
                isSelected,
                btnClass: `ticket-catalog-tab${isSelected ? ' ticket-catalog-tab--active' : ''}`
            };
        });
    }

    isMineCatalogTab(tab) {
        if (!tab) {
            return true;
        }
        return tab.type === 'mine' || tab.id === 'mine';
    }

    get showSidebarCalendarPanel() {
        return !this.isQuickActionMode && this.preferenceSidebarCalendar;
    }

    get showFullPageWeekStripBanner() {
        return !this.isQuickActionMode && !this.preferenceSidebarCalendar;
    }

    get showAmsTabPlaceholderBody() {
        const tab = this.activeCatalogTab;
        return tab?.type === 'ams' && this.ticketCount === 0 && !this.isLoading;
    }

    get showCatalogTabCreatedFilter() {
        const tab = this.activeCatalogTab;
        return tab && (tab.type === 'ams' || tab.supportsCreatedDateFilter === true);
    }

    get isQuickActionMode() {
        const v = this.quickActionMode;
        if (v === true) return true;
        if (v === false || v == null) return false;
        const s = String(v).trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes';
    }

    get mainLayoutClass() {
        return `main-layout slds-grid slds-wrap${this.isQuickActionMode ? ' main-layout--qa' : ''}`;
    }

    get stripRangeMonthLabel() {
        return `${MONTH_NAMES[this.calendarMonthDate.getMonth()]} ${this.calendarMonthDate.getFullYear()}`;
    }

    get stripDaysWrapClass() {
        const count = this.stripDays.length;
        const dense = count > 14 ? ' strip-month-grid--dense' : '';
        return `strip-days-wrap strip-days-wrap--qa strip-month-grid strip-weeks-2${dense}${this.stripDensity === 'compact' ? ' density-compact' : ' density-comfortable'}`;
    }

    get stripDaysWrapStyle() {
        const count = Math.max(1, this.stripDays.length || this.stripWindowSpan);
        return `--strip-day-count: ${count}`;
    }

    get stripDensityComfortableClass() {
        return `density-toggle-btn${this.stripDensity === 'comfortable' ? ' density-toggle-btn--on' : ''}`;
    }

    get stripDensityCompactClass() {
        return `density-toggle-btn${this.stripDensity === 'compact' ? ' density-toggle-btn--on' : ''}`;
    }

    handleStripDensityChange(event) {
        const mode = event.currentTarget?.dataset?.density;
        if (mode !== 'compact' && mode !== 'comfortable') return;
        this.stripDensity = mode;
    }

    get quickBatchProjectionLabel() {
        const dateCount = this.datesForSave.length;
        const th = Number(this.totalHoursPreview) || 0;
        const projected = th * dateCount;
        if (dateCount === 0) {
            return `Sin día seleccionado · ${this.formatHoursShort(th)} h en tabla (elige fecha para imputar)`;
        }
        if (dateCount === 1) {
            return `Día único · ${this.formatHoursShort(th)} preparadas`;
        }
        return `${dateCount} día(s) · ${this.formatHoursShort(projected)} proyectadas`;
    }

    stripHoursSubtitle(h) {
        if (!(Number(h) > 0)) {
            return '—';
        }
        const n = Math.round(Number(h) * 100) / 100;
        const t = Number.isInteger(n) ? String(n) : n.toFixed(1);
        return `${t} h`;
    }

    get stripWeeksCount() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        return Math.ceil(last / 7);
    }

    /**
     * Día inicial (1..N) del rango visible de la franja, recalculado siempre que cambia el mes.
     * - Si el mes mostrado es el actual: auto-ancla para que «hoy» quede a 3 días del borde izquierdo
     *   y deje ~10 días por delante visibles (clamp a los límites del mes).
     * - Si no es el mes actual: arranca en el día 1 salvo que el usuario haya navegado manualmente.
     * - Si el usuario ya navegó (stripWindowStartDay != null): respeta su elección con clamp.
     */
    normalizeStripWindowForCurrentMonth() {
        const maxStart = this.stripWindowMaxStartDay;
        if (Number.isInteger(this.stripWindowStartDay) && this.stripWindowStartDay >= 1) {
            this.stripWindowStartDay = Math.max(1, Math.min(this.stripWindowStartDay, maxStart));
        }
    }

    get stripWindowEffectiveStartDay() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        const win = this.stripWindowSpan;
        const maxStart = Math.max(1, last - win + 1);
        if (Number.isInteger(this.stripWindowStartDay) && this.stripWindowStartDay >= 1) {
            return Math.max(1, Math.min(this.stripWindowStartDay, maxStart));
        }
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === y && today.getMonth() === m;
        if (!isCurrentMonth || last <= win) {
            return 1;
        }
        const todayDay = today.getDate();
        const offsetFromLeft = 3;
        let start = todayDay - offsetFromLeft;
        if (start < 1) start = 1;
        if (start > maxStart) start = maxStart;
        return start;
    }

    get stripDays() {
        const out = [];
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth();
        const last = new Date(y, m + 1, 0).getDate();
        const weekLetters = ['DO', 'LU', 'MA', 'MI', 'JU', 'VI', 'SA'];
        const startDay = this.stripWindowEffectiveStartDay;
        const endDay = Math.min(last, startDay + this.stripWindowSpan - 1);
        for (let monthDay = startDay; monthDay <= endDay; monthDay += 1) {
            const d = new Date(y, m, monthDay);
            const iso = this.formatDateForCalendar(d);
            const imputable = this.isIsoImputable(iso);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const selected = this.selectedDates.includes(iso);
            const h = Number(this.dailyHoursByDate[iso]) || 0;
            const isHoliday = this.isHolidayDate(iso);
            const dowClass = isWeekend ? ' strip-day--weekend' : ' strip-day--weekday';

            let loadClass = '';
            if (!selected) {
                const jornadaMeta = this.effectiveWorkdayTargetHours;
                if (h >= jornadaMeta) {
                    loadClass = ' strip-load--full';
                } else if (h > 0) {
                    loadClass = ' strip-load--partial';
                } else {
                    loadClass = ' strip-load--empty';
                }
            }
            if (isHoliday) {
                loadClass += ' strip-day--holiday';
            }
            if (h >= this.dayHoursHighlightThreshold) {
                loadClass += ' strip-day--over8h';
            }

            const chip = this.stripHoursSubtitle(h);
            const titleParts = [`${this.formatDMY(iso)} (${weekLetters[d.getDay()]})`, `Imputado: ${chip}`];
            if (!imputable) {
                titleParts.push('Solo consulta: el mes no admite imputación con tu perfil');
            } else if (isHoliday) {
                titleParts.push('Feriado');
            } else if (h > this.effectiveHighDayHoursWarn) {
                titleParts.push(`Aviso: más de ${this.effectiveHighDayHoursWarn} h ya registradas ese día`);
            }
            const buttonClass = `strip-day-btn${dowClass}${loadClass}${selected ? ' selected' : ''}${!imputable ? ' strip-day--locked' : ''}`;
            const stripDay = {
                key: `strip-${iso}-t${this.operativeThemeGeneration}`,
                iso,
                dayNumber: monthDay,
                weekdayLetter: weekLetters[d.getDay()],
                hoursChip: chip,
                showDetailIcon: h > 0,
                dayTooltip: titleParts.join(' · '),
                disabled: !imputable,
                selected,
                buttonClass
            };
            stripDay.buttonStyle = buildStripDayButtonInlineStyle(stripDay, this.imputationCenterSettings);
            out.push(stripDay);
        }
        return out;
    }

    openImportModal() {
        this.importParsedPreview = undefined;
        this.importModalOpen = true;
    }

    closeImportModal() {
        this.importModalOpen = false;
        this.clearImportPreview();
    }

    clearImportPreview() {
        this.importParsedPreview = undefined;
        this.importFileInputKey += 1;
    }

    computeImportPreviewStats(parsed) {
        const ticketNums = new Set(parsed.map((p) => String(p.caseNumber).trim()));
        let withConsultorId = 0;
        parsed.forEach((p) => {
            if (p.imputingUserId) {
                withConsultorId += 1;
            }
        });
        const exactDuplicateLines = countExactDuplicateImportLines(parsed);
        return {
            parsedCount: parsed.length,
            uniqueTickets: ticketNums.size,
            exactDuplicateLines,
            withConsultorId
        };
    }

    async confirmImportSave() {
        const block = this.importParsedPreview;
        if (!block || !block.parsed || !block.parsed.length) {
            this.toast('Importar desde archivo', 'No hay datos listos para aplicar. Vuelve a elegir el archivo.', 'warning');
            return;
        }
        const dupes = Number(block.stats?.exactDuplicateLines) || 0;
        if (dupes > 0) {
            const okDup = await LightningConfirm.open({
                label: 'Filas duplicadas en el archivo',
                message: `Hay ${dupes} fila(s) idénticas a otra (mismo ticket, fecha, horas, comentario y no facturable). Se crearán todos los registros. ¿Continuar?`,
                variant: 'header'
            });
            if (!okDup) {
                return;
            }
        }
        await this.importSaveFromParsed(block.parsed);
    }

    async confirmImportApplyToTable() {
        const block = this.importParsedPreview;
        if (!block || !block.parsed || !block.parsed.length) {
            this.toast('Importar desde archivo', 'No hay datos listos para aplicar. Vuelve a elegir el archivo.', 'warning');
            return;
        }
        await this.applyImportedRows(block.parsed);
        this.importModalOpen = false;
        this.clearImportPreview();
    }

    cancelImportPreview() {
        this.clearImportPreview();
    }

    buildCalendar() {
        const year = this.calendarMonthDate.getFullYear();
        const month = this.calendarMonthDate.getMonth();
        const firstDayOfMonth = new Date(year, month, 1);
        const lastDayOfMonth = new Date(year, month + 1, 0);
        const daysInMonth = lastDayOfMonth.getDate();
        const firstWeekday = firstDayOfMonth.getDay();
        const today = this.todayLocalISODate();

        const days = [];

        for (let i = 0; i < firstWeekday; i += 1) {
            days.push({
                key: `empty-${month}-${i}`,
                isEmpty: true
            });
        }

        for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
            const date = new Date(year, month, dayNumber);
            const isoDate = this.formatDateForCalendar(date);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isHoliday = this.isHolidayDate(isoDate);
            const disabled = !this.isIsoImputable(isoDate);
            const hLoaded = Number(this.dailyHoursByDate[isoDate]) || 0;

            const buttonClass = this.computeDayClass({
                disabled,
                isWeekend,
                isHoliday,
                isoDate,
                isToday: isoDate === today,
                isAnchor: isoDate === this.entryDate,
                isMultiSelected: this.selectedDates.length > 1 && this.selectedDates.includes(isoDate)
            });
            const calDay = {
                key: `${isoDate}-t${this.operativeThemeGeneration}`,
                label: dayNumber,
                isoDate,
                disabled,
                isEmpty: false,
                showDetailIcon: hLoaded > 0,
                buttonClass
            };
            calDay.buttonStyle = buildCalDayButtonInlineStyle(calDay, this.imputationCenterSettings);
            days.push(calDay);
        }

        this.calendarDays = days;
    }

    formatDateForCalendar(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    parseIsoDate(iso) {
        if (!iso || typeof iso !== 'string') {
            return new Date();
        }
        const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
        if ([y, m, d].some((n) => Number.isNaN(n))) {
            return new Date();
        }
        return new Date(y, m - 1, d);
    }

    computeDayClass({ disabled, isWeekend, isHoliday, isoDate, isToday, isAnchor, isMultiSelected }) {
        let cssClass = 'cal-day selectable';

        if (disabled) {
            cssClass += ' disabled-day';
        } else {
            const h = Number(this.dailyHoursByDate[isoDate]) || 0;
            if (h >= this.dayHoursHighlightThreshold) {
                cssClass += ' cal-day--over8h';
            }
            if (h >= this.effectiveWorkdayTargetHours) {
                cssClass += ' goal-met';
            } else if (h > 0) {
                cssClass += ' partial-day';
            }
        }

        if (isToday) {
            cssClass += ' today';
        }
        if (isWeekend) {
            cssClass += ' weekend-day';
        }
        if (isHoliday) {
            cssClass += ' holiday-day';
        }

        if (isMultiSelected) {
            cssClass += ' multi-selected';
        }

        if (isAnchor) {
            cssClass += ' active';
        }

        return cssClass;
    }

    async loadMonthHours(options = {}) {
        const requestVersion = ++this._loadMonthHoursVersion;
        this._ticketBillableCacheKey = '';
        try {
            const y = this.calendarMonthDate.getFullYear();
            const m = this.calendarMonthDate.getMonth() + 1;
            const consultantUserId =
                this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : null;
            const raw = await getDailyHoursForMonth({
                year: y,
                month: m,
                consultantUserId
            });
            if (requestVersion !== this._loadMonthHoursVersion) {
                return;
            }
            const rows = JSON.parse(raw || '[]');
            const map = {};
            let fact = 0;
            let noFact = 0;
            let hasBreakdown = false;
            (rows || []).forEach((r) => {
                if (r && r.isoDate) {
                    map[r.isoDate] = Number(r.hours) || 0;
                }
                const hasRowBreakdown = r && (r.facturableHours != null || r.noFacturableHours != null);
                if (!hasRowBreakdown) {
                    return;
                }
                hasBreakdown = true;
                const f = Number(r.facturableHours);
                const nf = Number(r.noFacturableHours);
                fact += Number.isFinite(f) ? f : 0;
                noFact += Number.isFinite(nf) ? nf : 0;
            });
            this.dailyHoursByDate = map;
            this.monthFacturableHours = fact;
            this.monthNoFacturableHours = noFact;
            this.monthHasBreakdown = hasBreakdown;
            this.buildCalendar();
        } catch (e) {
            if (requestVersion !== this._loadMonthHoursVersion) {
                return;
            }
            this.dailyHoursByDate = {};
            this.monthFacturableHours = 0;
            this.monthNoFacturableHours = 0;
            this.monthHasBreakdown = false;
            this.buildCalendar();
        }
    }

    /* ===== Popup de tickets del mes (facturable / no facturable) ===== */

    openFacturableTicketList() {
        this.openTicketBillableModal('fact');
    }

    openNoFacturableTicketList() {
        this.openTicketBillableModal('nofact');
    }

    handleTicketListLegendKey(event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            const kind = event.currentTarget && event.currentTarget.dataset
                ? event.currentTarget.dataset.kind
                : 'fact';
            this.openTicketBillableModal(kind === 'nofact' ? 'nofact' : 'fact');
        }
    }

    openTicketBillableModal(kind) {
        this.ticketBillableModalKind = kind === 'nofact' ? 'nofact' : 'fact';
        this.ticketBillableModalOpen = true;
        this.loadMonthTicketsByBillable();
    }

    closeTicketBillableModal() {
        this.ticketBillableModalOpen = false;
    }

    async loadMonthTicketsByBillable() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth() + 1;
        const consultantUserId =
            this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : null;
        const cacheKey = `${y}-${m}-${consultantUserId || 'self'}`;
        if (cacheKey === this._ticketBillableCacheKey && !this.ticketBillableLoading) {
            return;
        }
        const requestVersion = ++this._loadTicketBillableVersion;
        this.ticketBillableLoading = true;
        try {
            const raw = await getMonthTicketsByBillable({ year: y, month: m, consultantUserId });
            if (requestVersion !== this._loadTicketBillableVersion) {
                return;
            }
            this.ticketBillableRows = JSON.parse(raw || '[]') || [];
            this._ticketBillableCacheKey = cacheKey;
        } catch (e) {
            if (requestVersion !== this._loadTicketBillableVersion) {
                return;
            }
            this.ticketBillableRows = [];
        } finally {
            if (requestVersion === this._loadTicketBillableVersion) {
                this.ticketBillableLoading = false;
            }
        }
    }

    get ticketBillableIsFact() {
        return this.ticketBillableModalKind !== 'nofact';
    }

    get ticketBillableMonthLabel() {
        try {
            const label = this.calendarMonthDate.toLocaleDateString('es-ES', {
                month: 'long',
                year: 'numeric'
            });
            return label.charAt(0).toUpperCase() + label.slice(1);
        } catch (e) {
            return '';
        }
    }

    get ticketBillableModalTitle() {
        return this.ticketBillableIsFact
            ? 'Tickets facturables del mes'
            : 'Tickets no facturables del mes';
    }

    get ticketBillableModalSubtitle() {
        return `Imputaciones guardadas de ${this.ticketBillableMonthLabel}, agrupadas por ticket.`;
    }

    get ticketBillableHeadClass() {
        return this.ticketBillableIsFact
            ? 'ticket-billable-head ticket-billable-head--fact'
            : 'ticket-billable-head ticket-billable-head--nofact';
    }

    get ticketBillableList() {
        const wantNoFact = !this.ticketBillableIsFact;
        const rows = (this.ticketBillableRows || []).filter((r) => r && r.noFacturable === wantNoFact);
        rows.sort((a, b) => (Number(b.hours) || 0) - (Number(a.hours) || 0));
        return rows.map((r, idx) => ({
            key: `${r.caseId || 'x'}-${idx}`,
            caseNumber: r.caseNumber || '(sin número)',
            subject: r.subject || 'Ticket sin asunto',
            hoursText: this.formatHoursShort(Number(r.hours) || 0)
        }));
    }

    get ticketBillableTotalText() {
        const wantNoFact = !this.ticketBillableIsFact;
        const sum = (this.ticketBillableRows || [])
            .filter((r) => r && r.noFacturable === wantNoFact)
            .reduce((acc, r) => acc + (Number(r.hours) || 0), 0);
        return this.formatHoursShort(sum);
    }

    get ticketBillableCount() {
        return this.ticketBillableList.length;
    }

    get ticketBillableEmpty() {
        return !this.ticketBillableLoading && this.ticketBillableList.length === 0;
    }

    get ticketBillableDotClass() {
        return this.ticketBillableIsFact
            ? 'ticket-billable-dot ticket-billable-dot--fact'
            : 'ticket-billable-dot ticket-billable-dot--nofact';
    }

    /**
     * Reusa el mes ya cargado por loadMonthHours si coincide con año y consultor; ahorra 1 de las 12 llamadas.
     * Devuelve {month:Decimal -> rawString|null}; mes reusable lleva un JSON ya serializado equivalente al de Apex.
     */
    buildReusableMonthForQuarter(year, consultantUserId) {
        const visibleYear = this.calendarMonthDate.getFullYear();
        if (year !== visibleYear) return null;
        const visibleConsultantId =
            this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : null;
        if (visibleConsultantId !== consultantUserId) return null;
        if (!this.monthHasBreakdown && !Object.keys(this.dailyHoursByDate || {}).length) return null;
        const month = this.calendarMonthDate.getMonth() + 1;
        const byIso = this.dailyHoursByDate || {};
        const rows = Object.keys(byIso).map((isoDate) => ({
            isoDate,
            hours: Number(byIso[isoDate]) || 0,
            facturableHours: null,
            noFacturableHours: null
        }));
        if (this.monthHasBreakdown && rows.length === 1) {
            rows[0].facturableHours = this.monthFacturableHours;
            rows[0].noFacturableHours = this.monthNoFacturableHours;
        } else if (this.monthHasBreakdown && rows.length > 1) {
            const lastIso = rows[rows.length - 1].isoDate;
            const last = rows.find((r) => r.isoDate === lastIso);
            last.facturableHours = this.monthFacturableHours;
            last.noFacturableHours = this.monthNoFacturableHours;
        }
        return { month, raw: JSON.stringify(rows) };
    }

    async loadCurrentYearQuarterFacturable(options = {}) {
        const now = new Date();
        const year = now.getFullYear();
        const consultantUserId = this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : null;
        const requestVersion = ++this._loadQuarterVersion;
        this.quarterFacturableLoading = true;
        try {
            const reusable = this.buildReusableMonthForQuarter(year, consultantUserId);
            const monthCalls = [];
            for (let month = 1; month <= 12; month += 1) {
                if (reusable && reusable.month === month) {
                    monthCalls.push(Promise.resolve(reusable.raw));
                    continue;
                }
                monthCalls.push(
                    getDailyHoursForMonth({
                        year,
                        month,
                        consultantUserId
                    })
                );
            }
            const rawByMonth = await Promise.all(monthCalls);
            if (requestVersion !== this._loadQuarterVersion) {
                return;
            }
            const totals = { 1: 0, 2: 0, 3: 0, 4: 0 };
            const data = {
                1: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
                2: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
                3: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
                4: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 }
            };
            // Sólo se usa para ESTIMAR facturable en meses sin desglose Ind (no es la meta).
            const pctFact = this.facturableTargetPctForUi / 100;
            rawByMonth.forEach((raw, monthIdx) => {
                const quarter = Math.floor(monthIdx / 3) + 1;
                const rows = JSON.parse(raw || '[]');
                let monthFact = 0;
                let monthNoFact = 0;
                let hasIndBreakdown = false;
                let monthTotal = 0;
                (rows || []).forEach((r) => {
                    const h = Number(r?.hours);
                    if (Number.isFinite(h)) {
                        monthTotal += h;
                    }
                    if (r && (r.facturableHours != null || r.noFacturableHours != null)) {
                        hasIndBreakdown = true;
                        const f = Number(r.facturableHours);
                        const nf = Number(r.noFacturableHours);
                        monthFact += Number.isFinite(f) ? f : 0;
                        monthNoFact += Number.isFinite(nf) ? nf : 0;
                    }
                });
                const factVal = hasIndBreakdown ? monthFact : monthTotal * pctFact;
                const noFactVal = hasIndBreakdown ? monthNoFact : monthTotal - factVal;
                const imputableVal = hasIndBreakdown ? monthFact + monthNoFact : monthTotal;
                const businessDays = this.businessDaysForYearMonth(year, monthIdx);
                // Meta = 100 % imputable (días hábiles × jornada); el bono se logra al % configurado.
                const metaVal = businessDays * this.effectiveWorkdayTargetHours;
                totals[quarter] += factVal;
                data[quarter].months.push({
                    key: `q${quarter}-m${monthIdx}`,
                    monthIdx,
                    monthName: MONTH_NAMES[monthIdx],
                    fact: factVal,
                    noFact: noFactVal,
                    imputable: imputableVal,
                    meta: metaVal,
                    pct: metaVal > 0 ? (factVal / metaVal) * 100 : 0,
                    isEstimated: !hasIndBreakdown && monthTotal > 0
                });
                data[quarter].totalFact += factVal;
                data[quarter].totalNoFact += noFactVal;
                data[quarter].totalImputable += imputableVal;
                data[quarter].totalMeta += metaVal;
            });
            [1, 2, 3, 4].forEach((q) => {
                const totMeta = data[q].totalMeta;
                data[q].pct = totMeta > 0 ? (data[q].totalFact / totMeta) * 100 : 0;
            });
            this.quarterFacturableHours = totals;
            this.quarterFacturableData = data;
        } catch (e) {
            if (requestVersion !== this._loadQuarterVersion) {
                return;
            }
            this.quarterFacturableHours = { 1: 0, 2: 0, 3: 0, 4: 0 };
            this.quarterFacturableData = {
                1: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
                2: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
                3: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 },
                4: { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 }
            };
        } finally {
            if (requestVersion === this._loadQuarterVersion) {
                this.quarterFacturableLoading = false;
            }
        }
    }

    /** Días hábiles (lun-vie no festivo fijo Chile) de un mes/año concreto. */
    businessDaysForYearMonth(year, monthIdx) {
        const lastDay = new Date(year, monthIdx + 1, 0).getDate();
        let count = 0;
        for (let day = 1; day <= lastDay; day += 1) {
            const d = new Date(year, monthIdx, day);
            const dow = d.getDay();
            const iso = this.formatDateForCalendar(d);
            if (dow !== 0 && dow !== 6 && !this.isHolidayDate(iso)) {
                count += 1;
            }
        }
        return count;
    }

    handleHoursChange(e) {
        const raw = e.target.value;
        if (raw === '' || raw === null || raw === undefined) {
            this.hours = null;
            return;
        }
        const n = parseFloat(raw);
        this.hours = Number.isNaN(n) ? null : n;
    }
    handleCommentChange(e) { this.comment = e.target.value; }
    handleSearchChange(e) {
        const raw = e.detail?.value ?? e.target?.value ?? '';
        this.searchTerm = String(raw).trim().toLowerCase();
    }
    async handleOwnerChange(e) {
        this.selectedOwnerId = e.detail.value;
        this.loadingStatusText = 'Actualizando resolutor y calendario…';
        this.isLoading = true;
        try {
            await this.loadTickets({ silent: true, nesting: true });
            await this.loadMonthHours({ nesting: true });
            this.loadCurrentYearQuarterFacturable({ nesting: true }).catch(() => {});
        } finally {
            this.isLoading = false;
        }
    }

    handleImputeOnBehalfChange(e) {
        this.adminImputeOnBehalfUserId = e.detail.value || '';
    }

    /** Id a enviar en EntryDTO.imputingUserId (null = usuario conectado en Apex). */
    resolveEffectiveImputingUserId() {
        if (!this.isImputationAdmin || !this.adminImputeOnBehalfUserId) {
            return null;
        }
        return this.adminImputeOnBehalfUserId;
    }

    /**
     * Consultor en registro al guardar una fila: opcional Id por fila (CSV, admin) gana sobre «A nombre de».
     */
    resolveImputingUserIdForSave(row) {
        if (this.isImputationAdmin && row && row._importImputingUserId) {
            return row._importImputingUserId;
        }
        return this.resolveEffectiveImputingUserId();
    }

    isLikelySalesforceUserId(value) {
        if (value == null || typeof value !== 'string') {
            return false;
        }
        const s = value.trim();
        return /^[a-zA-Z0-9]{15}$/.test(s) || /^[a-zA-Z0-9]{18}$/.test(s);
    }

    get imputeOnBehalfComboboxOptions() {
        if (!this.isImputationAdmin) {
            return [];
        }
        const uid = String(currentUserId || '');
        const opts = [{ label: 'Usuario conectado (yo)', value: '' }];
        const seen = new Set(['']);
        (this.ownerOptions || []).forEach((o) => {
            if (!o || !o.value || seen.has(o.value)) {
                return;
            }
            if (uid && o.value === uid) {
                return;
            }
            seen.add(o.value);
            opts.push({ label: o.label, value: o.value });
        });
        return opts;
    }
    handleNoFacturableChange(e) { this.noFacturable = e.detail.checked; }
    handleQuickComment(e) { this.comment = e.currentTarget.dataset.value; }
    handlePresetHour(e) {
        this.hours = Number(e.currentTarget.dataset.value);
    }

    get hourPresetButtons() {
        return this.hourPresets.map((p) => ({ key: `preset-${p}`, value: p }));
    }

    toggleSettings() {
        this.settingsOpen = !this.settingsOpen;
    }

    toggleBulkPanel() {
        this.bulkPanelOpen = !this.bulkPanelOpen;
        this.persistBulkPanelOpen();
    }

    handleQuickHoursToggle(e) {
        this.quickHoursEnabled = e.detail.checked;
        if (this.quickHoursEnabled) {
            this.bulkPanelOpen = true;
            this.persistBulkPanelOpen();
        }
    }

    toggleQuickSettings() {
        this.quickSettingsOpen = !this.quickSettingsOpen;
    }

    handleQuickHoursToggleFromSettings(e) {
        this.quickHoursEnabled = !!e.detail.checked;
    }

    handleQuickBillingToggleFromSettings(e) {
        this.quickBillingEnabled = !!e.detail.checked;
    }

    handleQuickCommentsToggle(e) {
        this.quickCommentsEnabled = e.detail.checked;
        if (this.quickCommentsEnabled) {
            this.bulkPanelOpen = true;
            this.persistBulkPanelOpen();
        }
    }

    handleImportFile(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = typeof reader.result === 'string' ? reader.result : '';
                const parsed = this.parseImportFile(text, file.name);
                const stats = this.computeImportPreviewStats(parsed);
                this.importParsedPreview = {
                    parsed,
                    fileName: file.name,
                    stats
                };
                this.refreshImportPreviewAccess(parsed, stats);
            } catch (err) {
                this.importParsedPreview = undefined;
                this.toast('Importar desde archivo', err.message || 'No se pudo leer el archivo. Comprueba que sea CSV (UTF-8) con el formato de la plantilla.', 'error');
            }
        };
        reader.readAsText(file, 'UTF-8');
    }

    registerTicketInCaseNumberMap(byNumber, row) {
        caseNumberLookupKeys(row.caseNumber).forEach((k) => {
            if (k) {
                byNumber.set(k, row);
            }
        });
    }

    findTicketRowByCaseNumber(ticketByNumber, caseNumber) {
        for (const k of caseNumberLookupKeys(caseNumber)) {
            const row = ticketByNumber.get(k);
            if (row) {
                return row;
            }
        }
        return undefined;
    }

    async refreshImportPreviewAccess(parsed, stats) {
        if (!parsed || !parsed.length) {
            return;
        }
        try {
            const ticketByNumber = await this.resolveTicketRowsForImport(parsed);
            let accessibleRows = 0;
            const unresolved = new Set();
            parsed.forEach((p) => {
                if (this.findTicketRowByCaseNumber(ticketByNumber, p.caseNumber)) {
                    accessibleRows += 1;
                } else {
                    unresolved.add(normalizeImportCaseNumber(p.caseNumber) || String(p.caseNumber));
                }
            });
            const block = this.importParsedPreview;
            if (!block || block.parsed !== parsed) {
                return;
            }
            this.importParsedPreview = {
                ...block,
                stats: {
                    ...stats,
                    accessibleRows,
                    unresolvedRows: parsed.length - accessibleRows,
                    unresolvedTicketNumbers: [...unresolved]
                }
            };
        } catch (ignore) {
            /* vista previa sin bloquear */
        }
    }

    async downloadTemplate() {
        const admin = this.isImputationAdmin;
        const fileName = admin ? 'plantilla_imputaciones_AMS_admin.csv' : 'plantilla_imputaciones_AMS.csv';
        const raw = admin ? plantillaImputacionesAdminUrl : plantillaImputacionesBasicaUrl;
        try {
            if (!raw || typeof raw !== 'string') {
                this.toast(
                    'Plantilla',
                    'No se encontró la plantilla en el sistema. Contacta con soporte para restaurar los recursos de plantillas AMS.',
                    'error'
                );
                return;
            }
            const href =
                raw.startsWith('http://') || raw.startsWith('https://')
                    ? raw
                    : `${window.location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
            const response = await fetch(href, { credentials: 'include', cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`No se pudo leer la plantilla (${response.status}).`);
            }
            const text = await response.text();
            const ownerDoc = (this.template && this.template.ownerDocument) || document;
            downloadTextFile(fileName, text, ownerDoc);
            this.toast('Plantilla', 'Descarga iniciada.', 'success');
        } catch (err) {
            this.toast('Plantilla', this.normalizeError(err) || 'No se pudo descargar la plantilla.', 'error');
        }
    }

    parseImportFile(text, fileName) {
        if (fileName && fileName.toLowerCase().endsWith('.xlsx')) {
            throw new Error('Sube un archivo CSV (en Excel: «Guardar como» → CSV delimitado por punto y coma).');
        }
        let raw = typeof text === 'string' ? text.replace(/^\ufeff/, '').trim() : '';
        let lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
        if (lines.length && lines[0].toLowerCase().startsWith('sep=')) {
            lines = lines.slice(1);
        }
        if (lines.length < 2) {
            throw new Error('El archivo debe tener cabecera y al menos una fila de datos.');
        }
        const delimiter = lines[0].includes(';') ? ';' : ',';
        const headers = lines[0].split(delimiter).map((h) => this.normalizeHeader(h));
        const idxCase = this.findColumnIndex(headers, ['casenumber', 'case', 'ticket', 'numerocaso', 'case_number']);
        const idxHours = this.findColumnIndex(headers, ['horas', 'hours']);
        const idxDate = this.findColumnIndex(headers, ['fecha', 'date']);
        const idxNf = this.findColumnIndex(headers, ['nofacturable', 'no_facturable', 'nofactura']);
        const idxFact = this.findColumnIndex(headers, ['facturable', 'billable']);
        const idxComment = this.findColumnIndex(headers, ['comentario', 'comment', 'comments']);
        const idxConsultor = this.findColumnIndex(headers, [
            'consultorid',
            'usuarioid',
            'imputinguserid',
            'usuarioimputacion',
            'userid',
            'user_id'
        ]);
        if (idxCase < 0 || idxHours < 0) {
            throw new Error('Cabecera invalida: se requieren columnas CaseNumber (o Ticket) y Horas.');
        }
        const out = [];
        for (let i = 1; i < lines.length; i++) {
            const parts = this.splitCsvLine(lines[i], delimiter);
            if (!parts.length) continue;
            let caseNumber = (parts[idxCase] || '').trim();
            if (caseNumber.startsWith("'")) {
                caseNumber = caseNumber.slice(1).trim();
            }
            caseNumber = normalizeImportCaseNumber(caseNumber);
            const hoursRaw = (parts[idxHours] || '').replace(',', '.').trim();
            const hours = parseFloat(hoursRaw);
            let rowDate;
            if (idxDate >= 0 && parts[idxDate] !== undefined && String(parts[idxDate]).trim() !== '') {
                rowDate = this.parseDateCell(parts[idxDate].trim());
            } else {
                rowDate = this.entryDate || this.todayLocalISODate();
            }
            if (!rowDate || !/^\d{4}-\d{2}-\d{2}$/.test(rowDate)) {
                rowDate = this.todayLocalISODate();
            }
            let nf = false;
            const nfCell = idxNf >= 0 ? parts[idxNf] : undefined;
            const factCell = idxFact >= 0 ? parts[idxFact] : undefined;
            const nfHasVal = nfCell !== undefined && String(nfCell).trim() !== '';
            const factHasVal = factCell !== undefined && String(factCell).trim() !== '';
            if (nfHasVal) {
                nf = this.parseBooleanCell(nfCell);
            } else if (factHasVal) {
                nf = !this.parseBooleanCell(factCell);
            }
            const com = idxComment >= 0 ? (parts[idxComment] || '').trim() : '';
            if (!caseNumber || Number.isNaN(hours) || hours <= 0) continue;
            const rowOut = { caseNumber, hours, fecha: rowDate, noFacturable: nf, comment: com };
            if (this.isImputationAdmin && idxConsultor >= 0 && parts[idxConsultor] !== undefined) {
                const cid = String(parts[idxConsultor]).trim();
                if (this.isLikelySalesforceUserId(cid)) {
                    rowOut.imputingUserId = cid;
                }
            }
            out.push(rowOut);
        }
        return out;
    }

    invalidatePendingBillableBreakdown() {
        this._billableBreakdownDirty = true;
    }

    indPredictionKey(caseId, plannedNoFacturable) {
        return `${caseId}|${plannedNoFacturable === true ? '1' : '0'}`;
    }

    getIndPredictionForRow(row) {
        if (!row || !row.caseId) return undefined;
        const key = this.indPredictionKey(row.caseId, row.plannedNoFacturable === true);
        return this._indPredictionCache.get(key);
    }

    /** Solo invalida caché de los caseIds dados (no de todos). */
    invalidateIndPredictionForCases(caseIds) {
        if (!Array.isArray(caseIds) || !caseIds.length) return;
        const ids = new Set(caseIds);
        const toDelete = [];
        for (const key of this._indPredictionCache.keys()) {
            const pipe = key.indexOf('|');
            const cid = pipe > 0 ? key.slice(0, pipe) : key;
            if (ids.has(cid)) toDelete.push(key);
        }
        toDelete.forEach((k) => this._indPredictionCache.delete(k));
    }

    /** Programa una llamada Apex única para los seleccionados pendientes (debounced 150 ms). */
    schedulePendingIndPrefetch() {
        if (this._indPrefetchTimer) {
            clearTimeout(this._indPrefetchTimer);
        }
        this._indPrefetchTimer = setTimeout(() => {
            this._indPrefetchTimer = null;
            this.runPendingIndPrefetch().catch(() => {});
        }, 150);
    }

    async runPendingIndPrefetch() {
        if (!Array.isArray(this.selectedRows) || !this.selectedRows.length) return;
        const rowsById = new Map();
        for (const r of this.rows || []) {
            rowsById.set(r.caseId, r);
        }
        const pending = [];
        const seenKeys = new Set();
        for (const caseId of this.selectedRows) {
            const row = rowsById.get(caseId);
            if (!row) continue;
            const key = this.indPredictionKey(caseId, row.plannedNoFacturable === true);
            if (this._indPredictionCache.has(key)) continue;
            if (this._indPredictionInFlight.has(key)) continue;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            pending.push({
                caseId,
                plannedNoFacturable: row.plannedNoFacturable === true,
                isAmsManagementCase: row.isAmsManagementCase === true,
                allowsFutureDates: row.allowsFutureDates === true,
                caseRuleFieldsJson: row.caseRuleFieldsJson || ''
            });
            this._indPredictionInFlight.add(key);
        }
        if (!pending.length) return;
        const version = ++this._indPrefetchVersion;
        try {
            const raw = await previewIndForSelectedCases({ requestJson: JSON.stringify(pending) });
            const parsed = raw ? JSON.parse(raw) : [];
            if (version !== this._indPrefetchVersion) {
                pending.forEach((p) =>
                    this._indPredictionInFlight.delete(this.indPredictionKey(p.caseId, p.plannedNoFacturable))
                );
                return;
            }
            (parsed || []).forEach((r) => {
                if (!r || !r.caseId) return;
                const key = this.indPredictionKey(r.caseId, r.plannedNoFacturable === true);
                this._indPredictionCache.set(key, {
                    isNoFacturable: r.isNoFacturable === true,
                    resolvedByInd: r.resolvedByInd === true
                });
                this._indPredictionInFlight.delete(key);
            });
            this.invalidatePendingBillableBreakdown();
            this.selectedRows = [...this.selectedRows];
        } catch (e) {
            pending.forEach((p) =>
                this._indPredictionInFlight.delete(this.indPredictionKey(p.caseId, p.plannedNoFacturable))
            );
        }
    }

    syncBillableRulesCache() {
        const raw =
            (this.imputationCenterSettings &&
                this.imputationCenterSettings.billableCriteriaFiltersJson) ||
            '';
        const key = String(raw);
        if (this._billableRulesJsonKey === key && this._billableRulesParsed) {
            return;
        }
        this._billableRulesJsonKey = key;
        this._billableRulesParsed = parseBillableRulesFromSettings(this.imputationCenterSettings);
        this._indPredictionCache.clear();
        this.invalidatePendingBillableBreakdown();
    }

    getCachedBillableRules() {
        this.syncBillableRulesCache();
        return (
            this._billableRulesParsed ||
            parseBillableRulesFromSettings(this.imputationCenterSettings)
        );
    }

    patchRow(caseId, patch) {
        this.rows = this.rows.map((r) => (r.caseId === caseId ? { ...r, ...patch } : r));
        this.invalidatePendingBillableBreakdown();
    }

    _eventChecked(e) {
        if (e?.detail && typeof e.detail.checked === 'boolean') {
            return e.detail.checked;
        }
        return !!e.target?.checked;
    }

    _eventValue(e) {
        if (e?.detail && Object.prototype.hasOwnProperty.call(e.detail, 'value')) {
            return e.detail.value;
        }
        return e.target?.value;
    }

    handleRowSelectionChange(e) {
        const caseId = e.currentTarget.dataset.rowId;
        if (!caseId) return;
        const checked = this._eventChecked(e);
        const next = new Set(this.selectedRows);
        if (checked) next.add(caseId);
        else next.delete(caseId);
        this.selectedRows = Array.from(next);
        this.invalidatePendingBillableBreakdown();
        this.schedulePendingIndPrefetch();
    }

    handleSelectAllFiltered(e) {
        const checked = this._eventChecked(e);
        if (checked) {
            this.selectedRows = this.filteredRows.map((r) => r.caseId);
        } else {
            const vis = new Set(this.filteredRows.map((r) => r.caseId));
            this.selectedRows = this.selectedRows.filter((id) => !vis.has(id));
        }
        this.invalidatePendingBillableBreakdown();
        this.schedulePendingIndPrefetch();
    }

    handleRowHoursChange(e) {
        const caseId = e.currentTarget.dataset.rowId;
        if (!caseId) return;
        const raw = this._eventValue(e);
        const parsed = raw === '' || raw === null ? null : parseFloat(raw);
        const nextHours = Number.isNaN(parsed) ? null : parsed;

        if (!this._hoursPatchTimers) {
            this._hoursPatchTimers = {};
        }
        if (!this._hoursPatchValues) {
            this._hoursPatchValues = {};
        }
        this._hoursPatchValues[caseId] = nextHours;
        if (this._hoursPatchTimers[caseId]) {
            clearTimeout(this._hoursPatchTimers[caseId]);
        }
        this._hoursPatchTimers[caseId] = setTimeout(() => {
            this.applyPendingHoursPatch(caseId);
        }, 60);
    }

    applyPendingHoursPatch(caseId) {
        if (!this._hoursPatchValues || !(caseId in this._hoursPatchValues)) {
            return;
        }
        const nextHours = this._hoursPatchValues[caseId];
        delete this._hoursPatchValues[caseId];
        if (this._hoursPatchTimers && this._hoursPatchTimers[caseId]) {
            clearTimeout(this._hoursPatchTimers[caseId]);
            delete this._hoursPatchTimers[caseId];
        }
        this.patchRow(caseId, { plannedHours: nextHours });
        if (Number.isFinite(nextHours) && nextHours > 0 && !this.selectedRows.includes(caseId)) {
            const selected = new Set(this.selectedRows);
            selected.add(caseId);
            this.selectedRows = Array.from(selected);
            this.schedulePendingIndPrefetch();
        }
    }

    flushPendingHoursPatch() {
        if (!this._hoursPatchValues) {
            return;
        }
        const keys = Object.keys(this._hoursPatchValues);
        for (const key of keys) {
            this.applyPendingHoursPatch(key);
        }
    }

    handleRowHoursKeyDown(e) {
        const idx = Number(e.currentTarget?.dataset?.rowIndex);
        if (!Number.isInteger(idx)) {
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!this.disableSave) {
                this.saveSelected();
            }
            return;
        }
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = this.template.querySelector(`lightning-input[data-row-index="${idx + 1}"]`);
            if (next) next.focus();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = this.template.querySelector(`lightning-input[data-row-index="${idx - 1}"]`);
            if (prev) prev.focus();
            return;
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            const next = this.template.querySelector(`lightning-input[data-row-index="${idx + 1}"]`);
            if (next) next.focus();
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const prev = this.template.querySelector(`lightning-input[data-row-index="${idx - 1}"]`);
            if (prev) prev.focus();
        }
    }

    applyHoursToSelection(event) {
        const h = Number(event.currentTarget?.dataset?.hours);
        if (!Number.isFinite(h) || h <= 0) return;
        if (!this.selectedRows.length) {
            this.toast('Atención', 'Selecciona tickets para aplicar horas.', 'warning');
            return;
        }
        const selectedSet = new Set(this.selectedRows);
        this.rows = this.rows.map((row) => (selectedSet.has(row.caseId) ? { ...row, plannedHours: h } : row));
        this.invalidatePendingBillableBreakdown();
        this.toast('Horas aplicadas', `${h} h aplicadas a ${this.selectedRows.length} ticket(s).`, 'success');
    }

    setNoFactToSelection(event) {
        const mode = event.currentTarget?.dataset?.mode;
        if (!this.selectedRows.length) {
            this.toast('Atención', 'Selecciona tickets para cambiar facturación.', 'warning');
            return;
        }
        const nonBillable = mode === 'nofact';
        const selectedSet = new Set(this.selectedRows);
        this.rows = this.rows.map((row) =>
            selectedSet.has(row.caseId)
                ? { ...row, plannedNoFacturable: nonBillable }
                : row
        );
        this.invalidatePendingBillableBreakdown();
        this.schedulePendingIndPrefetch();
        this.toast(
            'Facturación aplicada',
            `${nonBillable ? 'Marcado como no facturable' : 'Marcado como facturable'} en ${this.selectedRows.length} ticket(s).`,
            'success'
        );
    }

    handleRowCommentChange(e) {
        const caseId = e.currentTarget.dataset.rowId;
        if (!caseId) return;
        this.patchRow(caseId, { plannedComment: e.detail.value || '' });
    }

    openRowCommentModal(e) {
        const caseId = e.currentTarget?.dataset?.rowId;
        if (!caseId) return;
        const row = this.rows.find((r) => r.caseId === caseId);
        this.rowCommentRowId = caseId;
        this.rowCommentDraft = row?.plannedComment || '';
        this.rowCommentTicketLabel = row?.caseNumber || '';
        this.rowCommentModalOpen = true;
    }

    closeRowCommentModal() {
        this.rowCommentModalOpen = false;
        this.rowCommentDraft = '';
        this.rowCommentRowId = undefined;
        this.rowCommentTicketLabel = '';
    }

    handleRowCommentDraftChange(e) {
        this.rowCommentDraft = e.detail?.value || '';
    }

    saveRowCommentModal() {
        if (!this.rowCommentRowId) {
            this.closeRowCommentModal();
            return;
        }
        this.patchRow(this.rowCommentRowId, { plannedComment: this.rowCommentDraft || '' });
        this.closeRowCommentModal();
    }

    openRowDateModal(e) {
        const caseId = e.currentTarget?.dataset?.rowId;
        if (!caseId) return;
        const row = this.rows.find((r) => r.caseId === caseId);
        const rowDates = Array.isArray(row?._rowDates) ? row._rowDates.filter(Boolean) : [];
        this.rowDateRowId = caseId;
        this.rowDateTicketLabel = row?.caseNumber || '';
        this.rowDateSelectedDates = rowDates.length ? [...rowDates] : [this.entryDate || this.todayLocalISODate()];
        const anchor = this.rowDateSelectedDates[0] || this.todayLocalISODate();
        const d = this.parseIsoDate(anchor);
        this.rowDateMonthDate = new Date(d.getFullYear(), d.getMonth(), 1);
        this.rowDateIsDragging = false;
        this.rowDateDragAnchorIso = null;
        this.rowDateSuppressClick = false;
        this.rowDateModalOpen = true;
    }

    closeRowDateModal() {
        this.rowDateModalOpen = false;
        this.rowDateRowId = undefined;
        this.rowDateTicketLabel = '';
        this.rowDateSelectedDates = [];
        this.rowDateIsDragging = false;
        this.rowDateDragAnchorIso = null;
        this.rowDateSuppressClick = false;
    }

    handleRowDatePrevMonth() {
        this.rowDateMonthDate = new Date(this.rowDateMonthDate.getFullYear(), this.rowDateMonthDate.getMonth() - 1, 1);
    }

    handleRowDateNextMonth() {
        this.rowDateMonthDate = new Date(this.rowDateMonthDate.getFullYear(), this.rowDateMonthDate.getMonth() + 1, 1);
    }

    applyRowDateDragRange(anchorIso, currentIso) {
        if (!anchorIso || !currentIso) return;
        const range = this.fillIsoDateRangeInclusive(anchorIso, currentIso);
        if (!range.length) return;
        this.rowDateSelectedDates = range;
    }

    /** Contexto de fecha del modal por fila (para que VAC permita futuro). */
    get rowDateModalIsoOptions() {
        const row = this.rows.find((r) => r.caseId === this.rowDateRowId);
        return { allowFutureDates: !!(row && row.allowsFutureDates === true) };
    }

    /** Mensaje de "fuera de mes" adaptado a si la fila es VAC o no. */
    rowDateOutOfRangeToast() {
        const row = this.rows.find((r) => r.caseId === this.rowDateRowId);
        const isVac = row && row.allowsFutureDates === true;
        this.toast(
            'Fecha no disponible',
            isVac
                ? 'En vacaciones puedes elegir el mes en curso o fechas futuras, pero no meses anteriores.'
                : 'Con tu perfil solo puedes registrar horas en el mes en curso.',
            'warning'
        );
    }

    selectSingleRowDate(iso) {
        if (!iso) return;
        if (!this.isIsoImputable(iso, this.rowDateModalIsoOptions)) {
            this.rowDateOutOfRangeToast();
            return;
        }
        this.rowDateSelectedDates = [iso];
    }

    toggleRowDateInSelection(iso) {
        if (!iso) return;
        if (!this.isIsoImputable(iso, this.rowDateModalIsoOptions)) {
            this.rowDateOutOfRangeToast();
            return;
        }
        const idx = this.rowDateSelectedDates.indexOf(iso);
        if (idx >= 0) {
            const next = this.rowDateSelectedDates.filter((d) => d !== iso).sort();
            this.rowDateSelectedDates = next.length
                ? next
                : [this.entryDate || this.todayLocalISODate()];
        } else {
            this.rowDateSelectedDates = [...this.rowDateSelectedDates, iso].sort();
        }
    }

    handleRowDateDayMouseDown(event) {
        if (event.button !== 0) return;
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        const iso = event.currentTarget?.dataset?.date;
        if (!iso || !this.isIsoImputable(iso, this.rowDateModalIsoOptions)) return;
        this.rowDateIsDragging = true;
        this.rowDateSuppressClick = true;
        this.rowDateDragAnchorIso = iso;
        this.applyRowDateDragRange(iso, iso);
    }

    handleRowDateDayMouseEnter(event) {
        if (!this.rowDateIsDragging || !this.rowDateDragAnchorIso) return;
        const iso = event.currentTarget?.dataset?.date;
        if (!iso || !this.isIsoImputable(iso, this.rowDateModalIsoOptions)) return;
        this.applyRowDateDragRange(this.rowDateDragAnchorIso, iso);
    }

    handleRowDateDayClick(event) {
        if (this.rowDateSuppressClick) {
            this.rowDateSuppressClick = false;
            return;
        }
        const iso = event.currentTarget?.dataset?.date;
        if (!iso) return;
        if (!this.isIsoImputable(iso, this.rowDateModalIsoOptions)) {
            this.rowDateOutOfRangeToast();
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            this.toggleRowDateInSelection(iso);
        } else {
            this.selectSingleRowDate(iso);
        }
        this.rowDateIsDragging = false;
        this.rowDateDragAnchorIso = null;
    }

    handleRowEditActionKeydown(event) {
        const k = event.key;
        if (k !== 'Enter' && k !== ' ') return;
        event.preventDefault();
        this.openTicketRowEditImputation(event);
    }

    saveRowDateModal() {
        if (!this.rowDateRowId) {
            this.closeRowDateModal();
            return;
        }
        const sorted = [...new Set(this.rowDateSelectedDates)].sort();
        this.patchRow(this.rowDateRowId, { _rowDates: sorted, _importFecha: undefined });
        this.closeRowDateModal();
    }

    get rowDateMonthTitle() {
        return `${MONTH_NAMES[this.rowDateMonthDate.getMonth()]} ${this.rowDateMonthDate.getFullYear()}`;
    }

    get rowDateCalendarDays() {
        const out = [];
        const year = this.rowDateMonthDate.getFullYear();
        const month = this.rowDateMonthDate.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const lastDay = new Date(year, month + 1, 0).getDate();
        for (let i = 0; i < firstDay; i += 1) {
            out.push({ key: `row-empty-${i}`, isEmpty: true });
        }
        const ctxRow = this.rows.find((r) => r.caseId === this.rowDateRowId);
        const ctxOpts = { allowFutureDates: !!(ctxRow && ctxRow.allowsFutureDates === true) };
        for (let d = 1; d <= lastDay; d += 1) {
            const date = new Date(year, month, d);
            const iso = this.formatDateForCalendar(date);
            const selected = this.rowDateSelectedDates.includes(iso);
            const multi = this.rowDateSelectedDates.length > 1;
            const disabled = !this.isIsoImputable(iso, ctxOpts);
            const dow = date.getDay();
            let toneClass = '';
            if (this.isHolidayDate(iso)) {
                toneClass = ' rowdate-day--holiday';
            } else if (dow === 6) {
                toneClass = ' rowdate-day--sat';
            } else if (dow === 0) {
                toneClass = ' rowdate-day--sun';
            }
            out.push({
                key: `row-${iso}`,
                iso,
                label: d,
                isEmpty: false,
                disabled,
                className: `rowdate-day${toneClass}${selected ? ' rowdate-day--selected' : ''}${
                    multi && selected ? ' rowdate-day--multi' : ''
                }${disabled ? ' rowdate-day--disabled' : ''}`
            });
        }
        return out;
    }

    mapCaseImputationLinesFromApi(lines) {
        return (lines || []).map((l) => {
            const h = l.hours != null ? Number(l.hours) : NaN;
            const canEdit = l.canEdit === true;
            return {
                key: String(l.imputationId),
                imputationId: l.imputationId,
                isoDate:
                    l.isoDate && typeof l.isoDate === 'string' ? l.isoDate.slice(0, 10) : '',
                hoursStr: Number.isFinite(h) && h > 0 ? String(h) : '',
                noFacturable: l.noFacturable === true,
                comment: l.comment != null ? String(l.comment) : '',
                canEdit,
                isOwnLine: l.isOwnLine === true,
                readOnly: !canEdit,
                expanded: false
            };
        });
    }

    formatCaseImpHeaderDate(iso) {
        if (!iso || typeof iso !== 'string' || iso.length < 10) {
            return 'Sin fecha';
        }
        const y = parseInt(iso.slice(0, 4), 10);
        const m = parseInt(iso.slice(5, 7), 10);
        const d = parseInt(iso.slice(8, 10), 10);
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
            return 'Sin fecha';
        }
        const mi = MONTH_NAMES[m - 1];
        const monthShort = mi ? mi.slice(0, 3).toLowerCase() : '';
        return `${d} ${monthShort} ${y}`;
    }

    toggleCaseImpLine(event) {
        event.preventDefault();
        const id = event.currentTarget?.dataset?.imputationId;
        if (!id) {
            return;
        }
        this.caseImputationsEditLines = this.caseImputationsEditLines.map((r) =>
            String(r.imputationId) === String(id) ? { ...r, expanded: !r.expanded } : r
        );
    }

    startCaseImpAdd() {
        this.caseImpDraftVisible = true;
        this.caseImpDraftIsoDate = this.entryDate || this.todayLocalISODate();
        this.caseImpDraftHoursStr = '';
        this.caseImpDraftNoFacturable = false;
        this.caseImpDraftComment = '';
    }

    cancelCaseImpAdd() {
        this.caseImpDraftVisible = false;
        this.caseImpDraftHoursStr = '';
        this.caseImpDraftIsoDate = '';
        this.caseImpDraftNoFacturable = false;
        this.caseImpDraftComment = '';
        this.caseImpSavingNew = false;
    }

    handleCaseImpDraftHoursChange(e) {
        this.caseImpDraftHoursStr = e.detail.value;
    }

    handleCaseImpDraftDateChange(e) {
        this.caseImpDraftIsoDate = e.detail.value;
    }

    handleCaseImpDraftNfChange(e) {
        this.caseImpDraftNoFacturable = !!e.detail.checked;
    }

    handleCaseImpDraftCommentChange(e) {
        this.caseImpDraftComment = e.detail.value;
    }

    async saveCaseImpNew() {
        const caseId = this.caseImputationsEditCaseId;
        if (!caseId) {
            return;
        }
        const parsed = parseFloat(this.caseImpDraftHoursStr);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            this.toast('Atención', 'Las horas deben ser mayores que cero.', 'warning');
            return;
        }
        if (parsed > 24) {
            this.toast('Atención', 'Las horas no pueden superar 24.', 'warning');
            return;
        }
        const iso = this.caseImpDraftIsoDate;
        if (!iso || typeof iso !== 'string' || iso.length < 10) {
            this.toast('Atención', 'Indica una fecha válida.', 'warning');
            return;
        }
        const iso10 = iso.slice(0, 10);
        if (!this.isImputationAdmin && !this.isIsoImputable(iso10)) {
            this.toast('Atención', 'Solo puedes guardar en el mes en curso.', 'warning');
            return;
        }

        this.toastHeavyDaysIfSaving(new Set([iso10]));

        this.caseImpSavingNew = true;
        try {
            const entries = [
                {
                    rowKey: `modal-new-${caseId}-${Date.now()}`,
                    caseId,
                    imputingUserId: this.resolveEffectiveImputingUserId(),
                    entryDate: iso10,
                    hours: parsed,
                    noFacturable: this.resolveCaseImpNoFacturableForSave(this.caseImpDraftNoFacturable),
                    comment: this.caseImpDraftComment != null ? String(this.caseImpDraftComment).slice(0, 255) : '',
                    source: this.defaultImputationSource
                }
            ];
            const raw = await saveEntries({ entriesJson: JSON.stringify(entries) });
            const response = JSON.parse(raw || '{}');
            const ok = Number(response.ok) || 0;
            const failed = Number(response.failed) || 0;
            if (failed > 0 || ok === 0) {
                const firstErr = (response.results || []).find((r) => !r.success);
                const msg =
                    firstErr && firstErr.errors && firstErr.errors.length
                        ? firstErr.errors[0]
                        : 'No se pudo crear la imputación.';
                this.toast('No se guardó', msg, 'error');
                return;
            }
            this.toast('Imputación creada', 'Registro añadido al ticket.', 'success');
            this.cancelCaseImpAdd();
            const reload = await this.fetchCaseImputationLinesForEdit(
                caseId,
                this.caseImputationsEditOwnLinesOnly
            );
            if (reload.success) {
                this.applyCaseImputationModalResponse(reload);
            }
            await this.loadMonthHours({ nesting: true });
            await this.loadTickets({ silent: true, nesting: true });
            this.buildCalendar();
        } catch (err) {
            this.toast('Error', this.normalizeError(err), 'error');
        } finally {
            this.caseImpSavingNew = false;
        }
    }

    async fetchCaseImputationLinesForEdit(caseIdStr, ownLinesOnly = false) {
        const raw = await getCaseImputationLinesForEdit({ caseIdStr, ownLinesOnly: !!ownLinesOnly });
        return JSON.parse(raw || '{}');
    }

    applyCaseImputationModalResponse(resp) {
        this.caseImputationsEditLines = this.mapCaseImputationLinesFromApi(resp?.lines || []);
        this.caseImputationsEditCaseAllowsFutureDates = resp?.caseAllowsFutureDates === true;
        this.caseImputationsEditOwnLinesOnly = resp?.ownLinesOnlyMode === true;
        this.caseImputationsEditTicketHoursTotal = Number(resp?.ticketHoursTotal) || 0;
        this.caseImputationsEditUserHoursTotal = Number(resp?.userHoursTotal) || 0;
    }

    resolveCaseImpNoFacturableForSave(explicitValue) {
        return explicitValue === true;
    }

    closeCaseImputationsModal() {
        this.caseImputationsModalOpen = false;
        this.caseImputationsEditLines = [];
        this.caseImputationsTicketLabel = '';
        this.caseImputationsEditCaseId = null;
        this.caseImputationsEditOwnLinesOnly = false;
        this.caseImputationsEditTicketHoursTotal = 0;
        this.caseImputationsEditUserHoursTotal = 0;
        this.caseImputationsEditCaseNoFactLocked = false;
        this.caseImputationsSortNewestFirst = true;
        this.caseImputationsEditCaseAllowsFutureDates = false;
        this.caseLineSavingId = null;
        this.caseImpDeletingId = null;
        this.cancelCaseImpAdd();
    }

    patchCaseImputationLine(imputationId, patch) {
        const id = String(imputationId);
        this.caseImputationsEditLines = this.caseImputationsEditLines.map((r) =>
            String(r.imputationId) === id ? { ...r, ...patch } : r
        );
    }

    handleCaseImpHoursChange(e) {
        const id = e.currentTarget?.dataset?.imputationId;
        if (!id) return;
        this.patchCaseImputationLine(id, { hoursStr: e.detail.value });
    }

    handleCaseImpDateChange(e) {
        const id = e.currentTarget?.dataset?.imputationId;
        if (!id) return;
        this.patchCaseImputationLine(id, { isoDate: e.detail.value });
    }

    handleCaseImpNfChange(e) {
        const id = e.currentTarget?.dataset?.imputationId;
        if (!id) return;
        this.patchCaseImputationLine(id, { noFacturable: !!e.detail.checked });
    }

    handleCaseImpCommentChange(e) {
        const id = e.currentTarget?.dataset?.imputationId;
        if (!id) return;
        this.patchCaseImputationLine(id, { comment: e.detail.value });
    }

    async saveCaseImputationLine(event) {
        const impId = event.currentTarget?.dataset?.imputationId;
        if (!impId) return;
        const row = this.caseImputationsEditLines.find((r) => String(r.imputationId) === String(impId));
        if (!row || row.readOnly) {
            return;
        }
        const parsed = parseFloat(row.hoursStr);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            this.toast('Atención', 'Las horas deben ser mayores que cero.', 'warning');
            return;
        }
        if (parsed > 24) {
            this.toast('Atención', 'Las horas no pueden superar 24.', 'warning');
            return;
        }
        const iso = row.isoDate;
        if (!iso || typeof iso !== 'string' || iso.length < 10) {
            this.toast('Atención', 'Indica una fecha válida.', 'warning');
            return;
        }
        if (!this.isImputationAdmin) {
            const opts = { allowFutureDates: this.caseImputationsEditCaseAllowsFutureDates === true };
            if (!this.isIsoImputable(iso, opts)) {
                this.toast(
                    'Fecha no permitida',
                    opts.allowFutureDates
                        ? 'En vacaciones puedes elegir el mes en curso o fechas futuras, pero no meses anteriores.'
                        : 'Solo puedes guardar en el mes en curso.',
                    'warning'
                );
                return;
            }
        }

        const payload = {
            imputationId: impId,
            hours: parsed,
            entryDateIso: iso.slice(0, 10),
            noFacturable: this.resolveCaseImpNoFacturableForSave(row.noFacturable === true),
            comment: row.comment != null ? String(row.comment).slice(0, 255) : ''
        };

        this.caseLineSavingId = impId;
        try {
            const raw = await updateImputationRecord({ payloadJson: JSON.stringify(payload) });
            const resp = JSON.parse(raw || '{}');
            if (!resp.success) {
                this.toast('No se guardó', resp.message || 'Error al actualizar.', 'error');
                return;
            }
            this.toast('Guardado', 'Imputación actualizada.', 'success');
            const caseId = this.caseImputationsEditCaseId;
            if (caseId) {
                const reload = await this.fetchCaseImputationLinesForEdit(
                    caseId,
                    this.caseImputationsEditOwnLinesOnly
                );
                if (reload.success) {
                    this.applyCaseImputationModalResponse(reload);
                }
            }
            await this.loadMonthHours({ nesting: true });
            await this.loadTickets({ silent: true, nesting: true });
            this.loadCurrentYearQuarterFacturable({ nesting: true }).catch(() => {});
            this.buildCalendar();
        } catch (err) {
            this.toast('Error', this.normalizeError(err), 'error');
        } finally {
            this.caseLineSavingId = null;
        }
    }

    async handleCaseImpDeleteLine(event) {
        const impId = event.currentTarget?.dataset?.imputationId;
        if (!impId) {
            return;
        }
        const row = this.caseImputationsEditLines.find((r) => String(r.imputationId) === String(impId));
        if (!row || row.readOnly || !row.canEdit) {
            return;
        }
        const confirmed = await LightningConfirm.open({
            label: 'Eliminar imputación',
            message: '¿Eliminar esta imputación? Esta acción no se puede deshacer.',
            variant: 'header'
        });
        if (!confirmed) {
            return;
        }
        this.caseImpDeletingId = impId;
        try {
            const raw = await deleteImputationRecord({ imputationId: impId });
            const resp = JSON.parse(raw || '{}');
            if (!resp.success) {
                this.toast('No se eliminó', resp.message || 'No se pudo eliminar el registro.', 'error');
                return;
            }
            this.toast('Listo', 'Imputación eliminada.', 'success');
            const caseId = this.caseImputationsEditCaseId;
            if (caseId) {
                const reload = await this.fetchCaseImputationLinesForEdit(
                    caseId,
                    this.caseImputationsEditOwnLinesOnly
                );
                if (reload.success) {
                    this.applyCaseImputationModalResponse(reload);
                }
            }
            await this.loadMonthHours({ nesting: true });
            await this.loadTickets({ silent: true, nesting: true });
            this.loadCurrentYearQuarterFacturable({ nesting: true }).catch(() => {});
            this.buildCalendar();
        } catch (err) {
            this.toast('Error', this.normalizeError(err), 'error');
        } finally {
            this.caseImpDeletingId = null;
        }
    }

    async openTicketRowEditImputation(e) {
        const caseId = e.currentTarget?.dataset?.caseId;
        const ticketLabel = e.currentTarget?.dataset?.caseNumber || '';
        if (!caseId) {
            return;
        }
        const ownLinesOnly = this.ticketTabSource === 'ams' && !this.isImputationAdmin;
        const ticketRow = (this.rows || []).find((r) => String(r.caseId) === String(caseId));
        this.caseImputationsTicketLabel = ticketLabel;
        this.caseImputationsEditCaseId = caseId;
        this.caseImputationsEditOwnLinesOnly = ownLinesOnly;
        this.caseImputationsEditCaseNoFactLocked = false;
        this.caseImputationsSortNewestFirst = true;
        this.loadingStatusText = 'Cargando imputaciones…';
        this.isLoading = true;
        try {
            const resp = await this.fetchCaseImputationLinesForEdit(caseId, ownLinesOnly);
            if (!resp.success) {
                this.toast('No disponible', resp.message || 'No se pudieron cargar las imputaciones.', 'warning');
                return;
            }
            this.applyCaseImputationModalResponse(resp);
            this.cancelCaseImpAdd();
            this.caseImputationsModalOpen = true;
        } catch (err) {
            this.toast('Error', this.normalizeError(err), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    handleRowNfChange(e) {
        const caseId = e.currentTarget.dataset.rowId;
        if (!caseId) return;
        this.patchRow(caseId, { plannedNoFacturable: !!this._eventChecked(e) });
        this.schedulePendingIndPrefetch();
    }

    normalizeHeader(h) {
        return h.replace(/^\ufeff/, '').replace(/\s+/g, '').toLowerCase();
    }

    findColumnIndex(headers, names) {
        for (let i = 0; i < headers.length; i++) {
            if (names.includes(headers[i])) return i;
        }
        return -1;
    }

    splitCsvLine(line, delimiter) {
        return line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''));
    }

    parseDateCell(raw) {
        const fallback = this.entryDate || this.todayLocalISODate();
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        if (iso.test(raw)) return raw;
        const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
        const m = raw.match(dmy);
        if (m) {
            const dd = m[1].padStart(2, '0');
            const mm = m[2].padStart(2, '0');
            return `${m[3]}-${mm}-${dd}`;
        }
        return fallback;
    }

    parseBooleanCell(raw) {
        if (raw === undefined || raw === null) return false;
        const v = String(raw).trim().toLowerCase();
        return ['1', 'true', 'si', 'sí', 'yes', 'y', 'x'].includes(v);
    }

    async resolveTicketRowsForImport(parsed) {
        const numbers = [
            ...new Set(
                parsed
                    .flatMap((p) => caseNumberLookupKeys(p.caseNumber))
                    .filter(Boolean)
            )
        ];
        const byNumber = new Map();
        this.rows.forEach((r) => {
            this.registerTicketInCaseNumberMap(byNumber, r);
        });
        const missing = numbers.filter((n) => !byNumber.has(n));
        if (missing.length) {
            this.loadingStatusText = 'Buscando tickets del archivo…';
            this.isLoading = true;
            try {
                const fetchedRaw = await getTicketsByCaseNumbers({ caseNumbers: missing });
                const fetched = JSON.parse(fetchedRaw) || [];
                const existingIds = new Set(this.rows.map((r) => r.caseId));
                const fetchedRows = fetched
                    .filter((r) => r && r.caseId && !existingIds.has(r.caseId))
                    .map((row) => ({
                        ...row,
                        plannedHours: null,
                        plannedNoFacturable: false,
                        plannedComment: '',
                        _rowDates: []
                    }));
                if (fetchedRows.length) {
                    this.rows = [...this.rows, ...fetchedRows];
                }
                fetchedRows.forEach((r) => {
                    this.registerTicketInCaseNumberMap(byNumber, r);
                });
            } finally {
                this.isLoading = false;
            }
        }
        this.rows.forEach((r) => {
            this.registerTicketInCaseNumberMap(byNumber, r);
        });
        return byNumber;
    }

    buildImportEntriesFromParsed(parsed, ticketByNumber) {
        const entries = [];
        const firstByTicket = new Map();
        parsed.forEach((p, idx) => {
            const num = normalizeImportCaseNumber(p.caseNumber);
            const ticketRow = this.findTicketRowByCaseNumber(ticketByNumber, num);
            if (!ticketRow) {
                return;
            }
            const rowLike = {
                ...ticketRow,
                plannedNoFacturable: p.noFacturable === true
            };
            const entry = {
                rowKey: `import|${idx}|${ticketRow.caseId}|${p.fecha}`,
                caseId: ticketRow.caseId,
                imputingUserId: this.resolveImputingUserIdForImport(p, ticketRow),
                entryDate: p.fecha,
                hours: Number(p.hours),
                noFacturable: resolveConsultantNoFacturableForSave(rowLike),
                comment: p.comment || '',
                source: this.defaultImputationSource,
                _caseNumber: num
            };
            entries.push(entry);
            if (!firstByTicket.has(num)) {
                firstByTicket.set(num, p);
            }
        });
        return { entries, firstByTicket };
    }

    resolveImputingUserIdForImport(parsedLine, ticketRow) {
        if (this.isImputationAdmin && parsedLine.imputingUserId) {
            return parsedLine.imputingUserId;
        }
        return this.resolveImputingUserIdForSave(ticketRow);
    }

    validateImportEntriesClient(entries, ticketByNumber) {
        const errors = [];
        entries.forEach((e) => {
            const num = e._caseNumber || '';
            const ticketRow =
                this.findTicketRowByCaseNumber(ticketByNumber, num) ||
                this.rows.find((r) => r.caseId === e.caseId);
            const rowOpts = { allowFutureDates: ticketRow?.allowsFutureDates === true };
            if (!this.isImputationAdmin && e.entryDate && !this.isIsoImputable(e.entryDate, rowOpts)) {
                errors.push(
                    `Ticket ${num}: fecha ${this.formatDMY(e.entryDate)} fuera del periodo permitido.`
                );
            }
            if (e.entryDate && !this.isImputationAdmin) {
                const iso = e.entryDate;
                const dow = new Date(
                    parseInt(iso.slice(0, 4), 10),
                    parseInt(iso.slice(5, 7), 10) - 1,
                    parseInt(iso.slice(8, 10), 10)
                ).getDay();
                const isWeekend = dow === 0 || dow === 6;
                if (isWeekend && !this.allowWeekendImputation) {
                    errors.push(`Ticket ${num}: imputacion en fin de semana no permitida.`);
                }
                if (this.isHolidayDate(iso) && !this.allowHolidayImputation) {
                    errors.push(`Ticket ${num}: imputacion en festivo no permitida.`);
                }
            }
        });
        return errors;
    }

    async importSaveFromParsed(parsed) {
        this.loadingStatusText = 'Validando importación…';
        this.isLoading = true;
        try {
            const ticketByNumber = await this.resolveTicketRowsForImport(parsed);
            const { entries } = this.buildImportEntriesFromParsed(parsed, ticketByNumber);
            if (!entries.length) {
                const unresolved = [
                    ...new Set(
                        parsed
                            .map((p) => normalizeImportCaseNumber(p.caseNumber))
                            .filter(Boolean)
                    )
                ];
                const hint = unresolved.length
                    ? ` Tickets no resueltos: ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}.`
                    : '';
                this.toast(
                    'Importar desde archivo',
                    `Ninguna fila coincide con un ticket abierto y accesible. Revisa numeros y permisos.${hint} El ticket debe estar abierto y ser tuyo, de tu equipo, AMS o con imputaciones previas tuyas. Si Excel quito ceros al numero (17359 vs 00017359), guarda el CSV como texto.`,
                    'warning'
                );
                return;
            }
            const clientErrors = this.validateImportEntriesClient(entries, ticketByNumber);
            if (clientErrors.length) {
                this.toast('Importar desde archivo', clientErrors.slice(0, 5).join(' '), 'error');
                return;
            }
            const vRaw = await validateEntries({ entriesJson: JSON.stringify(entries) });
            const vResults = JSON.parse(vRaw) || [];
            const serverErrors = [];
            vResults.forEach((vr) => {
                if (vr && vr.isValid === false && vr.errors && vr.errors.length) {
                    serverErrors.push(vr.errors.join(' '));
                }
            });
            if (serverErrors.length) {
                this.toast(
                    'Importar desde archivo',
                    serverErrors.slice(0, 4).join(' '),
                    'error'
                );
                return;
            }
            const totalHours = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
            const confirmed = await LightningConfirm.open({
                label: 'Confirmar importación',
                message: `Se crearán ${entries.length} imputación(es), total ${this.formatHoursShort(totalHours)}. Mismas reglas que «Confirmar imputación» (fechas, AMS, vacaciones). ¿Continuar?`,
                variant: 'header'
            });
            if (!confirmed) {
                return;
            }
            this.loadingStatusText = 'Guardando importación…';
            const payload = entries.map((e) => {
                const copy = { ...e };
                delete copy._caseNumber;
                return copy;
            });
            const raw = await saveEntries({ entriesJson: JSON.stringify(payload) });
            const response = JSON.parse(raw);
            const ok = Number(response.ok) || 0;
            const failed = Number(response.failed) || 0;
            const entryDatesForToast = entries.map((e) => e.entryDate);
            const msg = this.buildSaveToastMessage(ok, failed, entryDatesForToast);
            const toastTitle =
                failed > 0 && ok > 0
                    ? 'Importación parcial'
                    : failed > 0
                      ? 'Importación no guardada'
                      : 'Importación correcta';
            this.toast(toastTitle, msg, failed > 0 ? 'warning' : 'success');
            if (failed === 0) {
                this.importModalOpen = false;
                this.clearImportPreview();
                this.pendingImportExtraEntries = [];
                await this.loadTickets({ silent: true, nesting: true });
                await this.loadMonthHours({ nesting: true });
                this.loadCurrentYearQuarterFacturable({ nesting: true }).catch(() => {});
            }
        } catch (e) {
            this.toast('Error', this.normalizeError(e), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    async exportImputations() {
        const y = this.calendarMonthDate.getFullYear();
        const m = this.calendarMonthDate.getMonth() + 1;
        const consultantId =
            this.isImputationAdmin && this.selectedOwnerId ? this.selectedOwnerId : undefined;
        this.loadingStatusText = 'Exportando imputaciones…';
        this.isLoading = true;
        try {
            const apexParams = { year: y, month: m };
            if (consultantId) {
                apexParams.consultantUserId = consultantId;
            }
            const raw = await exportImputationsForMonth(apexParams);
            const rows = JSON.parse(raw) || [];
            if (!rows.length) {
                this.toast(
                    'Exportar imputaciones',
                    'No hay imputaciones en este mes para exportar.',
                    'info'
                );
                return;
            }
            const ym = `${y}-${String(m).padStart(2, '0')}`;
            const fileName = `imputaciones_${ym}.csv`;
            const ownerDoc = (this.template && this.template.ownerDocument) || document;
            downloadTextFile(fileName, buildExportCsvContent(rows), ownerDoc);
            this.toast(
                'Exportar imputaciones',
                `Se exportaron ${rows.length} registro(s) del mes ${ym}.`,
                'success'
            );
        } catch (e) {
            this.toast('Exportar imputaciones', this.normalizeError(e), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    async applyImportedRows(parsed) {
        if (!parsed.length) {
            this.toast('Importar desde archivo', 'El archivo no tiene filas válidas. Revisa el separador (punto y coma), la cabecera y que haya datos.', 'warning');
            return;
        }
        const ticketByNumber = await this.resolveTicketRowsForImport(parsed);
        const { entries, firstByTicket } = this.buildImportEntriesFromParsed(parsed, ticketByNumber);
        const seenTicket = new Set();
        const extras = [];
        entries.forEach((e) => {
            const num = e._caseNumber;
            if (!seenTicket.has(num)) {
                seenTicket.add(num);
            } else {
                const { _caseNumber, ...rest } = e;
                extras.push(rest);
            }
        });
        this.pendingImportExtraEntries = extras;

        let matched = 0;
        const nextSel = new Set(this.selectedRows);
        this.rows = this.rows.map((row) => {
            const p = firstByTicket.get(normalizeImportCaseNumber(row.caseNumber));
            if (!p) {
                return row;
            }
            matched++;
            nextSel.add(row.caseId);
            const next = {
                ...row,
                plannedHours: p.hours,
                _importFecha: p.fecha || undefined,
                plannedNoFacturable: p.noFacturable === true,
                plannedComment: p.comment || row.plannedComment
            };
            if (p.imputingUserId) {
                next._importImputingUserId = p.imputingUserId;
            } else {
                delete next._importImputingUserId;
            }
            return next;
        });
        this.selectedRows = Array.from(nextSel);
        this.invalidatePendingBillableBreakdown();
        this.schedulePendingIndPrefetch();
        const notFound = Math.max(0, parsed.length - entries.length);
        const extraMsg =
            this.pendingImportExtraEntries.length > 0
                ? ` ${this.pendingImportExtraEntries.length} linea(s) extra se guardaran al pulsar «Confirmar imputacion».`
                : '';
        if (notFound === 0) {
            this.toast(
                'Importar desde archivo',
                `Se aplicaron ${matched} ticket(s) a la tabla (${parsed.length} fila(s) en archivo).${extraMsg}`,
                'success'
            );
        } else {
            this.toast(
                'Importar desde archivo',
                `Tabla: ${matched} ticket(s); ${notFound} fila(s) sin ticket accesible.${extraMsg}`,
                'warning'
            );
        }
        if (this.pendingImportExtraEntries.length > 0 && !extraMsg) {
            this.toast(
                'Importar desde archivo',
                'Varias filas del mismo ticket: confirma el lote para crear todos los registros.',
                'info'
            );
        }
    }

    async loadTickets(options = {}) {
        const silent = options && options.silent === true;
        const append = options && options.append === true;
        const nesting = options && options.nesting === true;
        const requestVersion = ++this._loadTicketsVersion;
        if (!nesting) {
            this.loadingStatusText = append ? 'Cargando más tickets…' : 'Cargando tickets…';
            this.isLoading = true;
        }
        try {
            const pageToFetch = append ? this.ticketPageNumber + 1 : 1;
            const tab = this.activeCatalogTab;
            const isMine = this.isMineCatalogTab(tab);
            const tabId = tab?.id || 'mine';
            const filter = {
                caseIds:
                    !isMine
                        ? []
                        : this.recordId && !this.isQuickActionMode
                          ? [this.recordId]
                          : [],
                ownerIds: this.isImputationAdmin && this.selectedOwnerId ? [this.selectedOwnerId] : [],
                pageSize: this.effectiveTicketPageSize,
                pageNumber: pageToFetch,
                listSource: tabId,
                ...(this.showCatalogTabCreatedFilter && this.amsCreatedFromDate
                    ? { createdDateFromIso: this.amsCreatedFromDate }
                    : {}),
                ...(this.showCatalogTabCreatedFilter && this.amsCreatedToDate
                    ? { createdDateToIso: this.amsCreatedToDate }
                    : {})
            };
            const res = await getTicketsForEntry({ filterJson: JSON.stringify(filter) });
            if (requestVersion !== this._loadTicketsVersion) {
                return;
            }
            const parsed = JSON.parse(res);

            const mapDefaults = (row) => ({
                ...row,
                plannedHours: null,
                plannedNoFacturable: false,
                plannedComment: '',
                _rowDates: []
            });

            if (append) {
                const existingIds = new Set(this.rows.map((r) => r.caseId));
                const onlyNew = parsed.filter((r) => !existingIds.has(r.caseId)).map(mapDefaults);
                this.rows = [...this.rows, ...onlyNew];
            } else {
                this.rows = parsed.map(mapDefaults);
                this.tableErrors = { rows: {} };
                this._indPredictionCache.clear();
            }
            this.invalidatePendingBillableBreakdown();
            this.ticketPageNumber = pageToFetch;
            this.hasMoreTickets = parsed.length === this.effectiveTicketPageSize;

            if (!silent && !append) {
                this.toast('Lista de tickets', `Se cargaron ${parsed.length} ticket(s) en la tabla.`, 'info');
            } else if (!silent && append) {
                this.toast('Lista de tickets', `Página ${pageToFetch}: se añadieron ${parsed.length} ticket(s) nuevos.`, 'info');
            }
        } catch (e) {
            if (requestVersion !== this._loadTicketsVersion) {
                return;
            }
            this.toast('Error', this.normalizeError(e), 'error');
        } finally {
            if (!nesting) {
                this.isLoading = false;
            }
        }
    }

    loadMoreTickets() {
        if (!this.hasMoreTickets || this.isLoading) return;
        this.loadTickets({ append: true, silent: false });
    }

    async saveSelected() {
        this.flushPendingHoursPatch();
        if (!this.selectedRows.length) {
            this.toast('Atención', 'Marca al menos un ticket en la tabla.', 'warning');
            return;
        }

        const selectedSet = new Set(this.selectedRows);
        const selectedRowsData = this.rows.filter((row) => selectedSet.has(row.caseId));
        const clientErrors = this.validateSelectedRows(selectedRowsData);
        if (Object.keys(clientErrors).length) {
            this.tableErrors = { rows: clientErrors };
            this.toast(
                'Revisa la tabla',
                'Hay tickets seleccionados sin horas válidas o sin fecha. Corrige lo indicado en rojo antes de guardar.',
                'warning'
            );
            return;
        }

        const dates = this.datesForSave;
        for (const row of selectedRowsData) {
            const rowDates = this.getRowDatesForSave(row, dates);
            if (!rowDates.length) {
                this.toast(
                    'Falta la fecha',
                    `El ticket ${row.caseNumber || ''} no tiene día de imputación. Elige uno en la franja de fechas o indícalo en el archivo / por ticket.`,
                    'warning'
                );
                return;
            }
            if (!this.isImputationAdmin) {
                const rowOpts = { allowFutureDates: row.allowsFutureDates === true };
                const bad = rowDates.filter((d) => !this.isIsoImputable(d, rowOpts));
                if (bad.length) {
                    const isVac = row.allowsFutureDates === true;
                    this.toast(
                        'Fechas no permitidas',
                        isVac
                            ? `El ticket ${row.caseNumber || ''} (vacaciones) admite mes en curso o fechas futuras, pero no meses anteriores.`
                            : `El ticket ${row.caseNumber || ''} solo admite imputaciones del mes en curso.`,
                        'warning'
                    );
                    return;
                }
            }
        }
        if ((this.pendingImportExtraEntries || []).length) {
            const ticketByNum = new Map(
                this.rows.map((r) => [String(r.caseNumber).trim(), r])
            );
            const extraClientErrors = this.validateImportEntriesClient(
                this.pendingImportExtraEntries.map((e) => {
                    const row = this.rows.find((r) => r.caseId === e.caseId);
                    return {
                        ...e,
                        _caseNumber: row ? String(row.caseNumber).trim() : ''
                    };
                }),
                ticketByNum
            );
            if (extraClientErrors.length) {
                this.toast('Revisa la importación', extraClientErrors.slice(0, 3).join(' '), 'warning');
                return;
            }
        }

        const containsWeekendDates = this.selectedRowsContainWeekendDates();
        const containsHolidayDates = this.selectedRowsContainHolidayDates();
        if (containsWeekendDates && !this.allowWeekendImputation) {
            this.toast(
                'Fin de semana no permitido',
                'La configuracion del centro no permite imputar en sabado ni domingo.',
                'error'
            );
            return;
        }
        if (containsHolidayDates && !this.allowHolidayImputation) {
            const msg =
                this.imputationCenterSettings?.holidayWarningText ||
                'La configuracion del centro no permite imputar en dias festivos.';
            this.toast('Feriado no permitido', msg, 'error');
            return;
        }

        const effectiveSaveDates = new Set();
        selectedRowsData.forEach((row) => {
            this.getRowDatesForSave(row, dates).forEach((sd) => effectiveSaveDates.add(sd));
        });
        this.toastHeavyDaysIfSaving(effectiveSaveDates);

        let confirmMessage = this.confirmSaveBriefMessage;
        const extraConfirm = this.imputationCenterSettings?.confirmImputationExtraText;
        if (extraConfirm && String(extraConfirm).trim()) {
            confirmMessage += '\n' + String(extraConfirm).trim();
        }
        if (containsWeekendDates) {
            const wk =
                this.imputationCenterSettings?.weekendConfirmText ||
                'Incluye fin de semana.';
            confirmMessage += '\n' + String(wk).trim();
        }
        if (containsHolidayDates && this.allowHolidayImputation) {
            const hol =
                this.imputationCenterSettings?.holidayWarningText ||
                'Incluye dia festivo.';
            confirmMessage += '\n' + String(hol).trim();
        }
        const confirmed = await LightningConfirm.open({
            label: 'Confirmar imputación',
            message: confirmMessage,
            variant: 'header'
        });
        if (!confirmed) return;

        this.loadingStatusText = 'Guardando imputaciones…';
        this.isLoading = true;
        try {
            const entries = [];
            selectedRowsData.forEach((row) => {
                const rowDates = this.getRowDatesForSave(row, dates);
                rowDates.forEach((fecha) => {
                    entries.push({
                        rowKey: `${row.caseId}|${fecha}`,
                        caseId: row.caseId,
                        imputingUserId: this.resolveImputingUserIdForSave(row),
                        entryDate: fecha,
                        hours: Number(row.plannedHours),
                        noFacturable: resolveConsultantNoFacturableForSave(row),
                        comment: row.plannedComment || '',
                        source: this.defaultImputationSource
                    });
                });
            });
            (this.pendingImportExtraEntries || []).forEach((extra, idx) => {
                entries.push({
                    ...extra,
                    rowKey: extra.rowKey || `import-extra|${idx}|${extra.caseId}|${extra.entryDate}`
                });
            });

            const entryDatesForToast = entries.map((e) => e.entryDate);

            const raw = await saveEntries({ entriesJson: JSON.stringify(entries) });
            const response = JSON.parse(raw);
            const serverRowErrors = {};
            (response.results || []).forEach((r) => {
                if (!r.success) {
                    const key = r.rowKey || '';
                    const bar = key.indexOf('|');
                    const caseId = bar >= 0 ? key.substring(0, bar) : key;
                    if (!caseId) return;
                    serverRowErrors[caseId] = {
                        title: 'No se pudo guardar',
                        messages: r.errors && r.errors.length ? r.errors : ['Se produjo un error al guardar. Vuelve a intentarlo.']
                    };
                }
            });
            this.tableErrors = { rows: serverRowErrors };

            const ok = Number(response.ok) || 0;
            const failed = Number(response.failed) || 0;
            const msg = this.buildSaveToastMessage(ok, failed, entryDatesForToast);

            const toastTitle =
                failed > 0 && ok > 0
                    ? 'Guardado parcial'
                    : failed > 0 && ok === 0
                      ? 'No se guardó el lote'
                      : 'Guardado correcto';

            this.toast(toastTitle, msg, failed > 0 ? 'warning' : 'success');
            if (ok > 0 && containsWeekendDates) {
                this.toast(
                    'Fin de semana',
                    'Parte del tiempo se registró en sábado o domingo. Confirma que tu empresa lo permite.',
                    'warning'
                );
            }

            if (failed === 0) {
                const remember = this.persistLastCommentAfterSuccessfulSave(selectedRowsData);
                this.clearEntryData();
                this.comment = remember;
                this.clearSelection();
                this.pendingImportExtraEntries = [];
                this.tableErrors = { rows: {} };
            }
            await this.loadTickets({ silent: true, nesting: true });
            await this.loadMonthHours({ nesting: true });
            this.loadCurrentYearQuarterFacturable({ nesting: true }).catch(() => {});
        } catch (e) {
            this.toast('Error', this.normalizeError(e), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    get selectedCount() {
        return this.selectedRows.length;
    }

    get ticketCount() {
        return this.rows.length;
    }

    get ticketsSectionTitle() {
        return `Tickets (${this.ticketCount})`;
    }

    get disableSave() {
        return this.isLoading || this.selectedCount === 0 || !this.formReady;
    }

    async loadUiOptions() {
        try {
            const raw = await getUiOptions();
            const options = JSON.parse(raw);

            this.isImputationAdmin = !!options.isImputationAdmin;

            this.ownerOptions = [
                { label: 'Todos los resolutores', value: '' },
                ...(options.owners || [])
            ];
            if (this.adminImputeOnBehalfUserId) {
                const allowed = new Set(this.imputeOnBehalfComboboxOptions.map((o) => o.value));
                if (!allowed.has(this.adminImputeOnBehalfUserId)) {
                    this.adminImputeOnBehalfUserId = '';
                }
            }
        } catch (e) {
            this.toast('Aviso', 'No se pudieron cargar algunas opciones de la pantalla. Si algo no se ve bien, recarga la página.', 'warning');
        }
    }

    hexToRgb(hex) {
        if (!hex) {
            return null;
        }
        let h = String(hex).trim();
        if (h.startsWith('#')) {
            h = h.slice(1);
        }
        if (h.length === 3) {
            h = h
                .split('')
                .map((c) => c + c)
                .join('');
        }
        if (h.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(h)) {
            return null;
        }
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    }

    get billableRules() {
        return this.getCachedBillableRules();
    }

    calendarThemeCssVars(settings) {
        const s = coerceOperativeThemeSettings(settings || {});
        const pairs = Object.entries(resolveCalendarCssVarsFromSettings(s));
        const overRaw = s.calColorOverThreshold;
        const overHex =
            overRaw != null && String(overRaw).trim() ? String(overRaw).trim() : '#EA580C';
        const rgb = this.hexToRgb(overHex);
        if (rgb) {
            pairs.push(['--cc-cal-over-outline', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`]);
        }
        return pairs;
    }

    /** Variables CSS del calendario (reactivo al JSON operativo). */
    get calendarThemeStyle() {
        const pairs = this.calendarThemeCssVars(this.imputationCenterSettings);
        if (!pairs.length) {
            return '';
        }
        return pairs.map(([name, val]) => `${name}:${val}`).join(';');
    }

    applyCalendarThemeFromSettings(settings) {
        const root = this.template?.querySelector('.pandora-wrapper');
        const host = this.template?.host;
        const targets = [root, host].filter(Boolean);
        if (!targets.length) {
            this._pendingThemeApply = true;
            return;
        }
        const pairs = this.calendarThemeCssVars(settings);
        for (const target of targets) {
            for (const [name, val] of pairs) {
                target.style.setProperty(name, val);
            }
        }
    }

  refreshOperativeThemeVisuals() {
        this.operativeThemeGeneration += 1;
        this._pendingThemeApply = true;
        this.applyCalendarThemeFromSettings(this.imputationCenterSettings);
        if (Array.isArray(this.calendarDays) && this.calendarDays.length) {
            this.buildCalendar();
        }
    }

    /** Lectura de configuracion operativa (objeto DEFAULT) para el centro y panel admin. */
    async prefetchImputationCenterSettings() {
        try {
            const [raw, themeRaw] = await Promise.all([
                getImputationCenterSettings(),
                getOperativeThemeSettings()
            ]);
            const parsed = JSON.parse(raw || '{}');
            const themeParsed = JSON.parse(themeRaw || '{}');
            const base = parsed && typeof parsed === 'object' ? parsed : {};
            const theme =
                themeParsed && typeof themeParsed === 'object' ? themeParsed : {};
            base.panelMetaCopyJson = repairPanelMetaCopyJson(base.panelMetaCopyJson);
            this.imputationCenterSettings = coerceOperativeThemeSettings({ ...base, ...theme });
            this.syncBillableRulesCache();
            this.operativeThemeReady = true;
            this.refreshOperativeThemeVisuals();
            if (parsed.operativeMaxPinnedTickets != null && Number(parsed.operativeMaxPinnedTickets) > 0) {
                this.uiMaxPinnedTickets = Math.min(99, Math.floor(Number(parsed.operativeMaxPinnedTickets)));
            }
            if (parsed.operativeStripCalendarDays != null && Number(parsed.operativeStripCalendarDays) > 0) {
                this.uiStripWindowDays = Math.min(31, Math.floor(Number(parsed.operativeStripCalendarDays)));
                this.normalizeStripWindowForCurrentMonth();
            }
            if (parsed.operativeDayHighlightHours != null && Number(parsed.operativeDayHighlightHours) > 0) {
                this.uiDayHighlightHours = Math.min(24, Number(parsed.operativeDayHighlightHours));
            }
            const tabIds = new Set(this.resolvedCatalogTabs.map((t) => t.id));
            if (!tabIds.has(this.ticketTabSource)) {
                this.ticketTabSource = this.resolvedCatalogTabs[0]?.id || 'mine';
            }
            if (parsed.uiHideAmsTab === true && this.ticketTabSource === 'ams') {
                this.ticketTabSource = this.resolvedCatalogTabs[0]?.id || 'mine';
            }
            if (Array.isArray(this.pinnedTicketIds) && this.pinnedTicketIds.length > this.maxPinnedLimit) {
                this.pinnedTicketIds = this.pinnedTicketIds.slice(0, this.maxPinnedLimit);
                this.persistPinnedTickets();
            }
        } catch (e) {
            this.imputationCenterSettings = coerceOperativeThemeSettings({});
            this.operativeThemeReady = false;
            this.toast(
                'Configuracion operativa',
                'No se pudo leer Configurar_Centro_Imputaciones__c (DEFAULT). Se usan valores por defecto. Revise permisos de objeto/campos.',
                'warning'
            );
        }
    }

    renderedCallback() {
        if (this._pendingThemeApply && this.imputationCenterSettings) {
            this._pendingThemeApply = false;
            this.applyCalendarThemeFromSettings(this.imputationCenterSettings);
        }
    }

    get adminCalcTransparencyHasWarnings() {
        return calcTransparencyHasWarnings(this.adminCalcTransparencyModel);
    }

    selectAllVisible() {
        this.selectedRows = this.filteredRows.map((row) => row.caseId);
        this.invalidatePendingBillableBreakdown();
        this.schedulePendingIndPrefetch();
    }

    clearSelection() {
        this.selectedRows = [];
        this.invalidatePendingBillableBreakdown();
    }

    clearEntryData() {
        this.hours = null;
        this.noFacturable = false;
        /* comment se reasigna en saveSelected tras guardado OK si hay último texto guardado */
        this.comment = '';
    }

    applyComposerToSelected() {
        if (!this.selectedRows.length) {
            this.toast('Atención', 'Marca primero los tickets a los que quieres copiar horas y comentario.', 'warning');
            return;
        }

        const selectedSet = new Set(this.selectedRows);
        this.rows = this.rows.map((row) => {
            if (!selectedSet.has(row.caseId)) return row;
            let nextHours = row.plannedHours;
            if (this.hours !== null && this.hours !== undefined && this.hours !== '') {
                const n = Number(this.hours);
                if (Number.isFinite(n)) nextHours = n;
            }
            return {
                ...row,
                plannedHours: nextHours,
                plannedNoFacturable: this.noFacturable === true,
                plannedComment:
                    this.comment != null && this.comment !== ''
                        ? this.comment
                        : row.plannedComment
            };
        });
        this.invalidatePendingBillableBreakdown();
        this.schedulePendingIndPrefetch();
        this.toast('Datos copiados', 'Se aplicaron horas, facturación y comentario a los tickets seleccionados.', 'success');
    }

    get filteredRows() {
        const base = this.rows;
        const q = String(this.searchTerm || '').trim().toLowerCase();
        const filtered = !q
            ? base
            : base.filter((row) => {
                  const caseNumber = String(row.caseNumber || '').toLowerCase();
                  const subject = String(row.subject || '').toLowerCase();
                  return caseNumber.includes(q) || subject.includes(q);
              });

        /* Anclados primero, en su orden de anclado; el resto conserva el orden de carga. */
        const pinned = Array.isArray(this.pinnedTicketIds) ? this.pinnedTicketIds : [];
        if (!pinned.length) return filtered;
        const pinnedSet = new Set(pinned);
        const pinnedRows = [];
        const restRows = [];
        for (const r of filtered) {
            if (pinnedSet.has(r.caseId)) pinnedRows.push(r);
            else restRows.push(r);
        }
        pinnedRows.sort((a, b) => pinned.indexOf(a.caseId) - pinned.indexOf(b.caseId));
        return [...pinnedRows, ...restRows];
    }

    toggleCaseImpDateSort() {
        this.caseImputationsSortNewestFirst = !this.caseImputationsSortNewestFirst;
    }

    sortCaseImputationLines(lines) {
        const sorted = [...(lines || [])];
        sorted.sort((a, b) => {
            const da = a?.isoDate && typeof a.isoDate === 'string' ? a.isoDate.slice(0, 10) : '';
            const db = b?.isoDate && typeof b.isoDate === 'string' ? b.isoDate.slice(0, 10) : '';
            const cmp = da.localeCompare(db);
            if (cmp !== 0) {
                return this.caseImputationsSortNewestFirst ? -cmp : cmp;
            }
            const idA = String(a?.imputationId || '');
            const idB = String(b?.imputationId || '');
            return this.caseImputationsSortNewestFirst ? idB.localeCompare(idA) : idA.localeCompare(idB);
        });
        return sorted;
    }

    get caseImpHoursSummaryVisible() {
        return this.caseImputationsModalOpen === true;
    }

    get caseImpNoFactFieldVisible() {
        return this.caseImputationsModalOpen === true;
    }

    get caseImpSortButtonLabel() {
        return this.caseImputationsSortNewestFirst ? 'Fecha ↓' : 'Fecha ↑';
    }

    get caseImpSortButtonTitle() {
        return this.caseImputationsSortNewestFirst
            ? 'Orden: imputaciones más recientes arriba'
            : 'Orden: imputaciones más antiguas arriba';
    }

    get caseImpHasLines() {
        return (this.caseImputationsEditLines || []).length > 0;
    }

    get caseImpAmsSummaryVisible() {
        return this.caseImpHoursSummaryVisible;
    }

    /** Suma en vivo de horas propias (todas las pestañas; en AMS solo hay propias). */
    get caseImpAmsUserHoursLive() {
        let sum = 0;
        for (const line of this.caseImputationsEditLines || []) {
            if (line.isOwnLine !== true) {
                continue;
            }
            const h = parseFloat(line.hoursStr);
            if (Number.isFinite(h) && h > 0) {
                sum += h;
            }
        }
        if (this.caseImpDraftVisible) {
            const draft = parseFloat(this.caseImpDraftHoursStr);
            if (Number.isFinite(draft) && draft > 0) {
                sum += draft;
            }
        }
        return Math.round(sum * 100) / 100;
    }

    get caseImpAmsUserHoursDisplay() {
        return this.formatHoursNumber(this.caseImpAmsUserHoursLive);
    }

    get caseImpAmsTicketHoursDisplay() {
        return this.formatHoursNumber(this.caseImputationsEditTicketHoursTotal);
    }

    get caseImpAmsSummaryLead() {
        return 'Tus horas en este ticket';
    }

    get caseImpAmsShowTicketTotal() {
        const ticketTotal = Number(this.caseImputationsEditTicketHoursTotal) || 0;
        return ticketTotal > 0;
    }

    get caseImpModalLeadText() {
        if (this.caseImputationsEditOwnLinesOnly) {
            return 'Desde aquí puedes crear, editar o eliminar tus imputaciones en este ticket de Gestión AMS.';
        }
        return 'Pulsa una fila para ver horas, fecha y comentario. Puedes crear, editar o eliminar tus imputaciones.';
    }

    get caseImpToolbarBusy() {
        return !!(this.caseImpSavingNew || this.caseLineSavingId || this.caseImpDeletingId);
    }

    get caseImputationsEditLinesUi() {
        const sid = this.caseLineSavingId;
        const delId = this.caseImpDeletingId;
        const sorted = this.sortCaseImputationLines(this.caseImputationsEditLines);
        return sorted.map((line) => {
            const expanded = !!line.expanded;
            const iso =
                line.isoDate && typeof line.isoDate === 'string' ? line.isoDate.slice(0, 10) : '';
            const hNum = parseFloat(line.hoursStr);
            const hoursSummaryText =
                Number.isFinite(hNum) && hNum > 0 ? this.formatHoursShort(hNum) : '';
            const busyLine = !!(sid || delId);
            return {
                ...line,
                dateDisplayLabel: this.formatCaseImpHeaderDate(iso),
                hoursSummaryText,
                caseImpChevronIcon: expanded ? 'utility:chevrondown' : 'utility:chevronright',
                isExpanded: expanded,
                caseImpCardClass: `case-imp-line-card${expanded ? ' case-imp-line-card--open' : ' case-imp-line-card--collapsed'}`,
                lineInputsDisabled: !!(line.readOnly || busyLine),
                lineSaveDisabled: !!(line.readOnly || busyLine),
                lineDeleteDisabled: !!(line.readOnly || busyLine),
                canDeleteImputation: line.canEdit === true && !line.readOnly
            };
        });
    }

    get displayTicketRows() {
        const sel = new Set(this.selectedRows);
        const errs = this.tableErrors && this.tableErrors.rows ? this.tableErrors.rows : {};
        const pinnedSet = new Set(
            Array.isArray(this.pinnedTicketIds) ? this.pinnedTicketIds : []
        );
        const pinnedCount = pinnedSet.size;
        return this.filteredRows.map((r, rowIdx) => {
            const err = errs[r.caseId];
            const msgs = err && err.messages ? err.messages : [];
            const selRow = sel.has(r.caseId);
            const prior = Number(r.alreadyImputedHours) || 0;
            const planned = Number(r.plannedHours);
            const plannedOk = Number.isFinite(planned) && planned > 0;
            const isPinned = pinnedSet.has(r.caseId);
            let trClass = 'ticket-table-row ticket-row';
            if (prior > 0) trClass += ' has-imputed';
            if (plannedOk) trClass += ' edited';
            if (selRow) trClass += ' ticket-row--selected';
            if (msgs.length) trClass += ' ticket-row--error';
            if (r.participationRole === 'Equipo') trClass += ' ticket-row--equipo';
            if (isPinned) trClass += ' ticket-row--pinned';
            return {
                ...r,
                rowIndex: rowIdx,
                hasImportDateFromCsv: !!r._importFecha,
                importDateDmY: r._importFecha ? this.formatDMY(r._importFecha) : '',
                importDateTooltip: r._importFecha
                    ? `Esta fecha de imputación (${this.formatDMY(r._importFecha)}) viene del archivo importado, no del calendario lateral.`
                    : '',
                rowSelected: selRow,
                rowErrorText: msgs.join(' '),
                hasRowError: msgs.length > 0,
                ticketHoverDetails: this.buildTicketHoverDetails(r),
                hoursDisplay:
                    r.plannedHours !== null && r.plannedHours !== undefined && r.plannedHours !== ''
                        ? String(r.plannedHours)
                        : '',
                commentDisplay: r.plannedComment || '',
                hasComment: !!(r.plannedComment && String(r.plannedComment).trim()),
                commentActionClass: `row-mini-action${r.plannedComment && String(r.plannedComment).trim() ? ' row-mini-action--active' : ''}`,
                rowDatesSummary:
                    Array.isArray(r._rowDates) && r._rowDates.length
                        ? `${r._rowDates.length} fecha(s)`
                        : r._importFecha
                            ? this.formatDMY(r._importFecha)
                            : this.entryDate
                                ? this.formatDMY(this.entryDate)
                                : 'Sin fecha global',
                participationBadgeClass:
                    r.participationRole === 'Equipo' ? 'participation-badge participation-equipo' : 'participation-badge participation-owner',
                showParticipationBadge: !!r.participationRole,
                amsNoFactLocked: false,
                imputedHoursHover: this.buildImputedCellTitle(r),
                alreadyImputedHoursFormatted: prior > 0 ? this.formatHoursNumber(prior) : '',
                hasPriorHours: prior > 0,
                caseRecordUrl: r.caseId ? `/lightning/r/Case/${r.caseId}/view` : '#',
                isPinned,
                pinIconName: isPinned ? 'utility:pinned' : 'utility:pin',
                pinIconTitle: isPinned
                    ? 'Desanclar ticket'
                    : pinnedCount >= this.maxPinnedLimit
                        ? `Máximo ${this.maxPinnedLimit} tickets anclados`
                        : 'Anclar ticket arriba de la lista',
                pinActionClass: `row-mini-action row-pin-action${isPinned ? ' row-pin-action--on' : ''}`,
                pinDisabled: !isPinned && pinnedCount >= this.maxPinnedLimit,
                trClass
            };
        });
    }

    get hasRows() {
        return this.filteredRows.length > 0;
    }

    get emptyDueToSearch() {
        return this.rows.length > 0 && this.filteredRows.length === 0;
    }

    get allFilteredSelected() {
        const fr = this.filteredRows;
        return fr.length > 0 && fr.every((r) => this.selectedRows.includes(r.caseId));
    }

    get totalHoursPreview() {
        if (this.selectedCount === 0) return 0;
        const selectedSet = new Set(this.selectedRows);
        let total = 0;
        this.rows.forEach((row) => {
            if (!selectedSet.has(row.caseId)) return;
            total += Number(row.plannedHours || 0);
        });
        return total;
    }

    get formReady() {
        if (this.selectedCount === 0) return false;
        const selectedSet = new Set(this.selectedRows);
        const fallbackDates = this.datesForSave;
        if (fallbackDates.length) {
            /* fallbackDates aplica a varias filas; usamos contexto global de filas seleccionadas. */
            if (!fallbackDates.every((d) => this.isIsoImputable(d))) return false;
        }
        for (const row of this.rows) {
            if (!selectedSet.has(row.caseId)) continue;
            const h = Number(row.plannedHours);
            if (!Number.isFinite(h) || h <= 0) return false;
            const rowDates = this.getRowDatesForSave(row, fallbackDates);
            if (!rowDates.length) return false;
            if (!this.isImputationAdmin) {
                /* Cada fila valida con su propio override (VAC permite futuro). */
                const rowOpts = { allowFutureDates: row.allowsFutureDates === true };
                if (rowDates.some((d) => !this.isIsoImputable(d, rowOpts))) return false;
            }
        }
        return true;
    }

    get confirmSaveMessage() {
        const plan = this.projectedSaveStats;
        if (plan.entries <= 0) {
            return 'No hay horas listas para guardar. Revisa fechas y cantidades en los tickets marcados.';
        }
        if (plan.uniqueDates <= 1) {
            return `Se van a crear ${plan.entries} registro(s) de tiempo, en total ${this.formatHoursShort(plan.totalHours)}. ¿Quieres continuar?`;
        }
        return `Se van a crear ${plan.entries} registro(s) en ${plan.uniqueDates} días distintos. Total aproximado: ${this.formatHoursShort(plan.totalHours)}. ¿Quieres continuar?`;
    }

    get confirmSaveBriefMessage() {
        const selectedSet = new Set(this.selectedRows);
        const fallbackDates = this.datesForSave;
        const uniq = new Set();
        this.rows.forEach((row) => {
            if (!selectedSet.has(row.caseId)) return;
            const h = Number(row.plannedHours);
            if (!Number.isFinite(h) || h <= 0) return;
            this.getRowDatesForSave(row, fallbackDates).forEach((d) => uniq.add(d));
        });
        const sorted = [...uniq].sort();
        const plan = this.projectedSaveStats;
        const datesTxt = sorted.length ? sorted.map((d) => this.formatDMY(d)).join(', ') : '—';
        let msg = `Día(s): ${datesTxt}\nTotal de horas a registrar: ${this.formatHoursShort(plan.totalHours)}.`;
        let csvBehalf = false;
        this.rows.forEach((row) => {
            if (!selectedSet.has(row.caseId)) {
                return;
            }
            if (row._importImputingUserId) {
                csvBehalf = true;
            }
        });
        if (csvBehalf) {
            msg += '\nAlgunas filas llevan «ConsultorId» en el CSV: ese valor tiene prioridad sobre «A nombre de».';
        }
        if (this.isImputationAdmin && this.adminImputeOnBehalfUserId) {
            const opt = this.imputeOnBehalfComboboxOptions.find((o) => o.value === this.adminImputeOnBehalfUserId);
            const who = opt ? opt.label : this.adminImputeOnBehalfUserId;
            msg += `\nLas horas quedarán a nombre de: ${who}.`;
        }
        return msg;
    }

    get projectedSaveStats() {
        const fallbackDates = this.datesForSave;
        const selectedSet = new Set(this.selectedRows);
        let entries = 0;
        let totalHours = 0;
        const uniqueDates = new Set();
        this.rows.forEach((row) => {
            if (!selectedSet.has(row.caseId)) return;
            const h = Number(row.plannedHours);
            if (!Number.isFinite(h) || h <= 0) return;
            const rowDates = this.getRowDatesForSave(row, fallbackDates);
            entries += rowDates.length;
            totalHours += h * rowDates.length;
            rowDates.forEach((d) => uniqueDates.add(d));
        });
        (this.pendingImportExtraEntries || []).forEach((extra) => {
            const h = Number(extra.hours);
            if (!Number.isFinite(h) || h <= 0) {
                return;
            }
            entries += 1;
            totalHours += h;
            if (extra.entryDate) {
                uniqueDates.add(extra.entryDate);
            }
        });
        return { entries, totalHours, uniqueDates: uniqueDates.size };
    }

    get saveRiskChecklist() {
        const uniqueDates = new Set();
        const selectedSet = new Set(this.selectedRows);
        const fallbackDates = this.datesForSave;
        const risks = [];
        if (this.selectedCount === 0) risks.push('Sin tickets seleccionados.');
        if (this.selectedRowsContainWeekendDates()) risks.push('Incluye fines de semana.');
        const plan = this.projectedSaveStats;
        if (plan.uniqueDates > 1) risks.push(`Se usarán ${plan.uniqueDates} fechas en el guardado.`);
        this.rows.forEach((row) => {
            if (!selectedSet.has(row.caseId)) return;
            this.getRowDatesForSave(row, fallbackDates).forEach((d) => uniqueDates.add(d));
        });
        const warnH = this.effectiveHighDayHoursWarn;
        const highDays = [...uniqueDates].filter((d) => (Number(this.dailyHoursByDate[d]) || 0) > warnH);
        if (highDays.length) {
            risks.push(`${highDays.length} día(s) ya superan ${warnH} h.`);
        }
        return risks;
    }

    get saveChecklistMessage() {
        const plan = this.projectedSaveStats;
        const lines = [
            `- Tickets seleccionados: ${this.selectedCount}`,
            `- Fechas efectivas: ${plan.uniqueDates}`,
            `- Imputaciones a crear: ${plan.entries}`,
            `- Horas proyectadas: ${this.formatHoursShort(plan.totalHours)}`
        ];
        const risks = this.saveRiskChecklist;
        if (risks.length) {
            lines.push('- Riesgos detectados:');
            risks.forEach((r) => lines.push(`  · ${r}`));
        } else {
            lines.push('- Riesgos detectados: ninguno');
        }
        return lines.join('\n');
    }

    get showImportPreviewBanner() {
        const ip = this.importParsedPreview;
        return !!(ip && ip.parsed && ip.parsed.length && ip.stats);
    }

    get importPreviewSummaryText() {
        const ip = this.importParsedPreview;
        if (!ip || !ip.stats) {
            return '';
        }
        const { parsedCount, uniqueTickets, exactDuplicateLines, accessibleRows, unresolvedRows } = ip.stats;
        let msg = `${parsedCount} fila(s) en el archivo (${uniqueTickets} ticket(s) distintos).`;
        if (accessibleRows != null) {
            if (unresolvedRows > 0) {
                msg += ` ${accessibleRows} fila(s) con ticket accesible; ${unresolvedRows} sin resolver.`;
            } else {
                msg += ` ${accessibleRows} fila(s) listas para guardar.`;
            }
        }
        if (exactDuplicateLines > 0) {
            msg += ` ${exactDuplicateLines} fila(s) repetidas (mismo ticket, fecha, horas y comentario).`;
        }
        return msg;
    }

    get importPreviewTableRows() {
        const parsed = this.importParsedPreview?.parsed;
        if (!Array.isArray(parsed) || !parsed.length) {
            return [];
        }
        return parsed.slice(0, 12).map((row, index) => ({
            key: `import-preview-${index}`,
            caseNumber: row.caseNumber || '—',
            hours: row.hours,
            fecha: row.fecha || '—',
            noFactLabel: row.noFacturable ? 'Sí' : 'No',
            commentShort: row.comment
                ? row.comment.length > 36
                    ? `${row.comment.slice(0, 36)}…`
                    : row.comment
                : '—'
        }));
    }

    get importPreviewHasMoreRows() {
        const n = this.importParsedPreview?.parsed?.length || 0;
        return n > 12;
    }

    get importPreviewMoreRowsLabel() {
        const n = this.importParsedPreview?.parsed?.length || 0;
        return n > 12 ? `… y ${n - 12} fila(s) más.` : '';
    }

    get importPreviewFileCaption() {
        return this.importParsedPreview && this.importParsedPreview.fileName
            ? `Archivo: ${this.importParsedPreview.fileName}`
            : '';
    }

    get downloadPlantillaCsvButtonTitle() {
        return this.isImputationAdmin
            ? 'Descarga plantilla_imputaciones_AMS_admin.csv (incluye columna opcional ConsultorId).'
            : 'Descarga plantilla_imputaciones_AMS.csv (sin columna ConsultorId).';
    }

    /** Texto extra en modal de importación (solo admins). */
    get importModalBehalfAdminNote() {
        if (!this.isImputationAdmin) {
            return '';
        }
        return 'Al descargar la plantilla, el archivo incluye la columna opcional «ConsultorId» (Id de usuario Pandora, 15 o 18 caracteres): al guardar el lote prevalece sobre «A nombre de». Sin esa columna ni «A nombre de», queda el usuario conectado.';
    }

    get showQuickBlocks() {
        return this.quickHoursEnabled || this.quickCommentsEnabled;
    }

    get showQuickHoursActions() {
        return this.quickHoursEnabled;
    }

    get showQuickBillingActions() {
        return this.quickBillingEnabled;
    }

    get helpHeaderMain() {
        return 'Marca los tickets, indica las horas en la tabla y confirma el lote. «Fecha de imputación»: selector de mes y calendario. «Importar Imputaciones»: carga en bloque desde un archivo.';
    }

    get helpTicketsTable() {
        if (this.isImputationAdmin) {
            return 'Busca por número de ticket o asunto. Puedes filtrar la vista y el calendario con «Resolutores» (propietario del ticket). Con «A nombre de» eliges el usuario al que quedarán asociadas las horas al guardar (por defecto, tú); es independiente del filtro. Columna «Imp. Ticket»: horas ya registradas en el ticket (desglose según Ind_Imputacion__c). «Horas»: cantidad que vas a guardar en este lote. «No fact.»: márcala solo si el tiempo no es facturable; al guardar, Salesforce aplica Ind_Imputacion__c.';
        }
        return 'Busca por número de ticket o asunto. Columna «Imp. Ticket»: horas ya registradas en el ticket (desglose según Ind_Imputacion__c). «Horas»: cantidad que vas a guardar en este lote. «No fact.»: márcala solo si el tiempo no es facturable; al guardar, Salesforce aplica Ind_Imputacion__c.';
    }

    get tableToolbarInnerClass() {
        return 'table-toolbar-inner';
    }

    get helpCalendarModes() {
        const monthWindow =
            'Puedes imputar en el rango de meses configurado en el centro (meses hacia atrás y adelante).';
        const base =
            'Un clic selecciona un solo día. Mantén pulsado y arrastra para elegir un rango seguido. Ctrl (Windows) o ⌘ (Mac) + clic añade o quita días no contiguos. En la acción rápida ves el mes completo; las flechas cambian el mes.';
        const alert = 'Si un día ya supera las 10 h, se mostrará un aviso automático.';
        if (this.isImputationAdmin) {
            return `${base} ${alert}`;
        }
        return `${base} ${monthWindow} ${alert}`;
    }

    get helpBillableChart() {
        return 'Mes guardado: Ind_Imputacion__c (fórmula). Lote pendiente: misma fórmula Ind por ticket (consultada al seleccionar/cambiar No fact.), con JSON del centro como respaldo. Trimestral Q1–Q4 abajo.';
    }

    get helpComposerLote() {
        const base =
            'Rellena la plantilla y pulsa «Aplicar a seleccionados» para copiar los datos a las filas marcadas. Tras un guardado correcto, el último comentario se recuerda en este navegador. La plantilla incluye la columna opcional «NoFacturable» (true/false) y la importación por CSV permite fijar una fecha distinta por ticket.';
        if (this.isImputationAdmin) {
            return `${base} La plantilla incluye la columna opcional «ConsultorId».`;
        }
        return base;
    }

    /**
     * Lote pendiente: usa cache Ind por caso si esta resuelto (mismo criterio que tras guardar).
     * Mientras la prediccion Apex aun no llega para una fila recien seleccionada, optamos por
     * FA optimista (salvo que el usuario haya marcado "No fact." o sea PEP de vacaciones).
     * Asi evitamos el "flash NF -> FA" que producia el fallback a reglas JSON cuando estas no
     * coinciden con la formula Ind real (p.ej. amsFallback). Apex corrige a NF en ~150ms si
     * realmente correspondia.
     */
    get billableBreakdown() {
        if (!this._billableBreakdownDirty && this._billableBreakdownCached) {
            return this._billableBreakdownCached;
        }
        const selectedSet = new Set(this.selectedRows || []);
        const fallbackDates = this.datesForSave;
        let fact = 0;
        let noFact = 0;
        (this.rows || []).forEach((row) => {
            if (!selectedSet.has(row.caseId)) return;
            const h = Number(row.plannedHours);
            if (!Number.isFinite(h) || h <= 0) return;
            const rowDates = this.getRowDatesForSave(row, fallbackDates);
            const multiplier = (rowDates && rowDates.length) || 1;

            let isNf;
            if (row.allowsFutureDates === true) {
                isNf = false;
            } else {
                const pred = this.getIndPredictionForRow(row);
                if (pred) {
                    isNf = pred.isNoFacturable === true;
                } else if (row.plannedNoFacturable === true) {
                    isNf = true;
                } else {
                    isNf = false;
                }
            }
            if (isNf) {
                noFact += h * multiplier;
            } else {
                fact += h * multiplier;
            }
        });
        const result = { fact, noFact, total: fact + noFact };
        this._billableBreakdownCached = result;
        this._billableBreakdownDirty = false;
        return result;
    }

    get hasBillableChartData() {
        return this.activeBillableBreakdown.total > 0;
    }

    get billableDonutStyle() {
        const { fact, total } = this.activeBillableBreakdown;
        if (total <= 0) {
            return 'background: #e4e4e7;';
        }
        const deg = (fact / total) * 360;
        const { fact: factColor, noFact: noFactColor } = this.resolvedChartColors;
        return `background: conic-gradient(${factColor} 0deg ${deg}deg, ${noFactColor} ${deg}deg 360deg);`;
    }

    get billablePctFactLabel() {
        if (!this.monthlyFacturableTargetHours) return '—';
        return `${Math.round(this.monthlyFacturableProgressPct)}%`;
    }

    get billableDonutSubLabel() {
        return 'de meta';
    }

    get billableHoursFactFormatted() {
        return this.formatHoursShort(this.activeBillableBreakdown.fact);
    }

    get billableHoursNoFactFormatted() {
        return this.formatHoursShort(this.activeBillableBreakdown.noFact);
    }

    /** Imputable = facturable + no facturable (total imputado del mes en curso + lote pendiente). */
    get billableHoursImputableFormatted() {
        return this.formatHoursShort(this.activeBillableBreakdown.total);
    }

    /** % de un valor sobre la meta (100 % imputable). Redondeado para etiquetas. */
    metaPctOf(value) {
        const meta = this.monthlyFacturableTargetHours;
        if (!meta) return 0;
        return Math.round((Number(value) / meta) * 100);
    }

    /** Etiquetas combinadas "h · %meta" para la leyenda del panel mensual. */
    get billableFactLegendText() {
        return `${this.billableHoursFactFormatted} · ${this.metaPctOf(this.activeBillableBreakdown.fact)}%`;
    }

    get billableNoFactLegendText() {
        return `${this.billableHoursNoFactFormatted} · ${this.metaPctOf(this.activeBillableBreakdown.noFact)}%`;
    }

    get billableImputableLegendText() {
        return `${this.billableHoursImputableFormatted} · ${this.metaPctOf(this.activeBillableBreakdown.total)}%`;
    }

    get billableChartHint() {
        if (this.billableBreakdown.total <= 0) {
            return 'Selecciona tickets con horas: el gráfico usará la fórmula Ind por ticket (consulta una sola vez al seleccionar).';
        }
        return 'Mes guardado (Ind). Lote pendiente (Ind por ticket, calculado al seleccionar).';
    }

    get monthlyHoursTotal() {
        return Object.values(this.dailyHoursByDate || {}).reduce((acc, val) => acc + (Number(val) || 0), 0);
    }

    get monthlyHoursTotalFormatted() {
        return this.formatHoursShort(this.monthlyHoursTotal);
    }

    get businessDaysInMonth() {
        const year = this.calendarMonthDate.getFullYear();
        const month = this.calendarMonthDate.getMonth();
        const lastDay = new Date(year, month + 1, 0).getDate();
        let count = 0;
        for (let day = 1; day <= lastDay; day += 1) {
            const dow = new Date(year, month, day).getDay();
            const iso = this.formatDateForCalendar(new Date(year, month, day));
            if (dow !== 0 && dow !== 6 && !this.isHolidayDate(iso)) count += 1;
        }
        return count;
    }

    get monthlyGoalHours() {
        return this.businessDaysInMonth * this.effectiveWorkdayTargetHours;
    }

    /**
     * Meta facturable = 100 % de las horas imputables del mes (días hábiles × jornada).
     * Antes el denominador era el 85 % (× facturableTargetPctForUi); ahora ese % pasa a ser
     * el umbral del BONO (ver bonoThresholdPct), no la meta. Así el dónut sólo llega a 100 %
     * con la jornada completa imputada como facturable, y el bono se señala vía mensajes al
     * alcanzar el % configurado.
     */
    get monthlyFacturableTargetHours() {
        return this.monthlyGoalHours;
    }

    /** Expuesto al marcado para etiquetas dinámicas (% meta facturable codificado). */
    get codeFacturableTargetPct() {
        return this.facturableTargetPctForUi;
    }

    /**
     * Umbral del bono = % facturable configurado en el centro de imputaciones.
     * Controla cuándo se disparan los mensajes/badges/pips del tramo "bono logrado".
     * Si se cambia el % en la configuración, el bono se mueve solo.
     */
    get bonoThresholdPct() {
        return this.facturableTargetPctForUi;
    }

    get monthlyFacturableProgressPct() {
        const target = this.monthlyFacturableTargetHours;
        if (!target) return 0;
        return (this.activeBillableBreakdown.fact / target) * 100;
    }

    get monthlyFacturableProgressPctRounded() {
        return Math.round(this.monthlyFacturableProgressPct);
    }

    get monthlyFacturableGoalStyle() {
        const p = this.monthlyFacturableProgressPct;
        const color = this.resolvedChartColors.meta;
        return `width: ${Math.min(100, Math.max(0, p))}%; background: ${color};`;
    }

    get monthlyFacturableProgressLabel() {
        const pct = Math.round(this.monthlyFacturableProgressPct);
        const bono = this.bonoThresholdPct;
        return `${pct}% de la meta imputación (${this.formatHoursShort(this.activeBillableBreakdown.fact)} / ${this.formatHoursShort(this.monthlyFacturableTargetHours)}) · bono desde ${bono}%`;
    }

    get monthlyBonoMarkerStyle() {
        const bono = Math.min(100, Math.max(0, Number(this.bonoThresholdPct) || 0));
        return `left: ${bono}%`;
    }

    get monthMetaImputableText() {
        return this.formatHoursShort(this.monthlyGoalHours);
    }

    get monthMetaFacturableBonoText() {
        const pct = Number(this.bonoThresholdPct) || 0;
        const hours = (Number(this.monthlyGoalHours) || 0) * (pct / 100);
        return this.formatHoursShort(hours);
    }

    openMonthMetaHelpModal() {
        this.monthMetaHelpModalOpen = true;
    }

    closeMonthMetaHelpModal() {
        this.monthMetaHelpModalOpen = false;
    }

    get monthHoursBreakdownTooltip() {
        const estimation = this.monthlyBreakdownIsEstimated ? ' (estimado)' : '';
        return `Desglose del mes en curso${estimation}: facturable ${this.billableHoursFactFormatted} · no facturable ${this.billableHoursNoFactFormatted} · imputable ${this.billableHoursImputableFormatted}. Meta mensual: 100 % imputable (${this.formatHoursShort(this.monthlyGoalHours)}); bono al ${this.bonoThresholdPct} % facturable.`;
    }

    get monthlyBillableBreakdown() {
        if (this.monthHasBreakdown) {
            const fact = Number(this.monthFacturableHours) || 0;
            const noFact = Number(this.monthNoFacturableHours) || 0;
            return { fact, noFact, total: fact + noFact };
        }
        const total = this.monthlyHoursTotal;
        if (total <= 0) return { fact: 0, noFact: 0, total: 0 };
        const fact = total * (this.facturableTargetPctForUi / 100);
        const noFact = total - fact;
        return { fact, noFact, total };
    }

    get activeBillableBreakdown() {
        const month = this.monthlyBillableBreakdown;
        const pending = this.billableBreakdown;
        return {
            fact: month.fact + pending.fact,
            noFact: month.noFact + pending.noFact,
            total: month.total + pending.total
        };
    }

    get monthlyBreakdownIsEstimated() {
        return !this.monthHasBreakdown && this.monthlyHoursTotal > 0;
    }

    get monthlyBarFactStyle() {
        const b = this.activeBillableBreakdown;
        const color = this.resolvedChartColors.fact;
        if (!b.total) return `width: 0%; background: ${color};`;
        return `width: ${(b.fact / b.total) * 100}%; background: ${color};`;
    }

    get monthlyBarNoFactStyle() {
        const b = this.activeBillableBreakdown;
        const color = this.resolvedChartColors.noFact;
        if (!b.total) return `width: 0%; background: ${color};`;
        return `width: ${(b.noFact / b.total) * 100}%; background: ${color};`;
    }

    /** Un solo tipo efectivo para vista e iconos (localStorage u otros valores raros → dona). */
    get normalizedMonthlyChartType() {
        const t = this.monthlyChartType;
        return CHART_TYPES.has(t) ? t : 'donut';
    }

    get isMonthlyChartDonut() {
        return this.normalizedMonthlyChartType === 'donut';
    }

    get isMonthlyChartBars() {
        return this.normalizedMonthlyChartType === 'bars';
    }

    get isMonthlyChartStacked() {
        return this.normalizedMonthlyChartType === 'stacked';
    }

    get chartTypeIconBtnClassDonut() {
        return `chart-type-icon-btn${this.normalizedMonthlyChartType === 'donut' ? ' chart-type-icon-btn--on' : ''}`;
    }

    get chartTypeIconBtnClassBars() {
        return `chart-type-icon-btn${this.normalizedMonthlyChartType === 'bars' ? ' chart-type-icon-btn--on' : ''}`;
    }

    get chartTypeIconBtnClassStacked() {
        return `chart-type-icon-btn${this.normalizedMonthlyChartType === 'stacked' ? ' chart-type-icon-btn--on' : ''}`;
    }

    get showCatalogTabHint() {
        return !!this.catalogTabHintText;
    }

    get showCatalogTabExtra() {
        return this.showCatalogTabHint || this.showCatalogTabCreatedFilter;
    }

    get catalogTabHintText() {
        const tab = this.activeCatalogTab;
        const configuredHint = tab?.tabHint != null ? tab.tabHint : tab?.hint;
        return configuredHint != null ? String(configuredHint).trim() : '';
    }

    /** True si hay al menos una de las dos fechas del filtro AMS por fecha de creación. */
    get hasAmsCreatedFilter() {
        return !!(this.amsCreatedFromDate || this.amsCreatedToDate);
    }

    handleAmsCreatedFromChange(event) {
        const v = event && event.target ? event.target.value : '';
        this.amsCreatedFromDate = v || '';
        this.amsCreatedFilterTouched = true;
        this.reloadAmsTickets();
    }

    handleAmsCreatedToChange(event) {
        const v = event && event.target ? event.target.value : '';
        this.amsCreatedToDate = v || '';
        this.amsCreatedFilterTouched = true;
        this.reloadAmsTickets();
    }

    handleAmsCreatedFilterClear() {
        if (!this.amsCreatedFromDate && !this.amsCreatedToDate) return;
        this.amsCreatedFromDate = '';
        this.amsCreatedToDate = '';
        this.amsCreatedFilterTouched = true;
        this.reloadAmsTickets();
    }

    reloadAmsTickets() {
        if (!this.showCatalogTabCreatedFilter) {
            return;
        }
        this.ticketPageNumber = 1;
        this.loadTickets({ silent: true });
    }

    /** Si el usuario no ha tocado el filtro, lo precarga con el mes en curso. */
    ensureAmsCreatedFilterDefault() {
        if (this.amsCreatedFilterTouched) return;
        if (this.amsCreatedFromDate || this.amsCreatedToDate) return;
        const tab = this.activeCatalogTab;
        const fmt = (d) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const isAmsTab = tab && (tab.type === 'ams' || tab.id === 'ams');
        const tabDays = tab?.createdDateDaysBack;
        const nDays = Number(
            tabDays != null && tabDays !== '' && !Number.isNaN(Number(tabDays))
                ? tabDays
                : isAmsTab
                  ? this.imputationCenterSettings?.amsCreatedFilterDaysBack
                  : NaN
        );
        if (Number.isFinite(nDays) && nDays > 0) {
            const end = new Date();
            const start = new Date(end);
            start.setDate(start.getDate() - Math.min(3650, Math.floor(nDays)));
            this.amsCreatedFromDate = fmt(start);
            this.amsCreatedToDate = fmt(end);
            return;
        }
        const ref = this.calendarMonthDate || new Date();
        const y = ref.getFullYear();
        const m = ref.getMonth();
        const firstDay = new Date(y, m, 1);
        const lastDay = new Date(y, m + 1, 0);
        this.amsCreatedFromDate = fmt(firstDay);
        this.amsCreatedToDate = fmt(lastDay);
    }

    get headerLeftTableClass() {
        return 'header-left';
    }

    get monthlyGoalFunLabel() {
        return this.resolvePanelMetaText('msg', this.monthlyFacturableProgressPct);
    }

    get goalProgressPips() {
        const filled = this.metaTierFilled(this.monthlyFacturableProgressPct);
        return [0, 1, 2, 3].map((i) => ({
            key: `goal-pip-${i}`,
            className: `goal-pip${i < filled ? ' goal-pip--on' : ''}`
        }));
    }

    get monthlyGoalPipsAria() {
        const filled = this.metaTierFilled(this.monthlyFacturableProgressPct);
        return `Avance hacia la meta: ${filled} de 4 tramos superados.`;
    }

    get monthlyGoalBadgeIcon() {
        return this.resolvePanelMetaIcon(this.monthlyFacturableProgressPct);
    }

    get monthlyGoalBadgeLabel() {
        return this.resolvePanelMetaText('badge', this.monthlyFacturableProgressPct);
    }

    get monthlyGoalBadgeClass() {
        const filled = this.metaTierFilled(this.monthlyFacturableProgressPct);
        if (filled >= 3) return 'goal-badge goal-badge--win';
        if (filled === 2) return 'goal-badge goal-badge--near';
        if (filled === 1) return 'goal-badge goal-badge--mid';
        return 'goal-badge goal-badge--low';
    }

    get billableChartAriaLabel() {
        const b = this.activeBillableBreakdown;
        if (b.total <= 0) {
            return 'Gráfico de facturable vs no facturable: sin horas en la selección.';
        }
        const p = Math.round((b.fact / b.total) * 100);
        return `Gráfico: ${p} por ciento facturable, ${this.formatHoursShort(b.fact)}; ${100 - p} por ciento no facturable, ${this.formatHoursShort(b.noFact)}.`;
    }

    get currentQuarterNumber() {
        return Math.floor(new Date().getMonth() / 3) + 1;
    }

    get currentQuarterFacturableFormatted() {
        return this.formatHoursShort(this.quarterFacturableHours[this.currentQuarterNumber] || 0);
    }

    get currentQuarterPctText() {
        const data = this.quarterFacturableData[this.currentQuarterNumber];
        const pct = data ? Math.round(data.pct || 0) : 0;
        return `${pct}%`;
    }

    get quarterFacturableRows() {
        const currentQuarter = this.currentQuarterNumber;
        return [1, 2, 3, 4].map((q) => {
            const data = this.quarterFacturableData[q] || { totalFact: 0, totalMeta: 0, pct: 0 };
            const pct = Math.round(data.pct || 0);
            return {
                key: `q-fact-${q}`,
                qValue: String(q),
                label: `Q${q}`,
                pctText: `${pct}%`,
                summary: `${this.formatHoursShort(data.totalFact || 0)} / ${this.formatHoursShort(data.totalMeta || 0)}`,
                rowClass: `quarter-row${q === currentQuarter ? ' quarter-row--current' : ''}`,
                ariaLabel: `Detalle del trimestre Q${q}: ${pct}% facturable acumulado.`
            };
        });
    }

    handleQuarterRowClick(event) {
        const ds = event && event.currentTarget && event.currentTarget.dataset;
        const q = ds ? parseInt(ds.q, 10) : NaN;
        if (!Number.isFinite(q) || q < 1 || q > 4) {
            return;
        }
        this.quarterDetailQ = q;
        this.quarterDetailOpen = true;
    }

    closeQuarterDetailModal() {
        this.quarterDetailOpen = false;
    }

    get quarterDetailModel() {
        const q = this.quarterDetailQ;
        if (!q) {
            return null;
        }
        const data =
            this.quarterFacturableData[q] ||
            { months: [], totalFact: 0, totalNoFact: 0, totalImputable: 0, totalMeta: 0, pct: 0 };
        const pctOfMeta = (value, meta) => (meta > 0 ? Math.round((Number(value) / meta) * 100) : 0);
        const metricCell = (value, meta, suffix) => ({
            hoursText: `${this.formatHoursShort(value)}${suffix || ''}`,
            pctText: `${pctOfMeta(value, meta)}%`
        });
        const monthRows = (data.months || []).map((m) => {
            const estimatedSuffix = m.isEstimated ? ' (estimado)' : '';
            const imputable = metricCell(m.imputable, m.meta);
            const fact = metricCell(m.fact, m.meta, estimatedSuffix);
            const noFact = metricCell(m.noFact, m.meta);
            return {
                key: m.key,
                monthName: m.monthName,
                imputableHoursText: imputable.hoursText,
                imputablePctText: imputable.pctText,
                factHoursText: fact.hoursText,
                factPctText: fact.pctText,
                noFactHoursText: noFact.hoursText,
                noFactPctText: noFact.pctText,
                metaText: this.formatHoursShort(m.meta),
                rowClass: m.isEstimated ? 'quarter-detail-row quarter-detail-row--estimated' : 'quarter-detail-row'
            };
        });
        const totalImputable = metricCell(data.totalImputable || 0, data.totalMeta);
        const totalFact = metricCell(data.totalFact || 0, data.totalMeta);
        const totalNoFact = metricCell(data.totalNoFact || 0, data.totalMeta);
        const bono = this.bonoThresholdPct;
        return {
            title: `Trimestre Q${q}`,
            heading: `Detalle facturable Q${q}`,
            description: `Suma de los 3 meses del trimestre del año en curso. La meta es el 100 % imputable (días hábiles × jornada); el bono se logra al ${bono} % facturable. Cada % se calcula sobre la meta.`,
            rows: monthRows,
            totalImputableHoursText: totalImputable.hoursText,
            totalImputablePctText: totalImputable.pctText,
            totalFactHoursText: totalFact.hoursText,
            totalFactPctText: totalFact.pctText,
            totalNoFactHoursText: totalNoFact.hoursText,
            totalNoFactPctText: totalNoFact.pctText,
            totalMetaText: this.formatHoursShort(data.totalMeta || 0)
        };
    }

    buildTicketHoverDetails(row) {
        const parts = [];
        parts.push(`Ticket: ${row.caseNumber || '-'}`);
        if (row.caseSubject || row.subject) parts.push(`Asunto: ${row.caseSubject || row.subject}`);
        if (row.status || row.caseStatus) parts.push(`Estado: ${row.status || row.caseStatus}`);
        if (row.priority) parts.push(`Prioridad: ${row.priority}`);
        parts.push(`Horas imputadas (${this.imputedTotalsSummaryLine(row)})`);
        return parts.join(' | ');
    }

    imputedTotalsSummaryLine(row) {
        const tot = Number(row.alreadyImputedHours) || 0;
        if (!(row.billableHoursSplitAvailable === true)) {
            return `total ${this.formatHoursShort(tot)}`;
        }
        const f = Number(row.alreadyImputedFacturableHours) || 0;
        const n = Number(row.alreadyImputedNoFacturableHours) || 0;
        return `fact. ${this.formatHoursShort(f)} · no fact. ${this.formatHoursShort(n)} · total ${this.formatHoursShort(tot)}`;
    }

    /** title nativo en la celda de horas imputadas */
    buildImputedCellTitle(row) {
        const tot = Number(row.alreadyImputedHours) || 0;
        if (tot <= 0) return 'Sin horas imputadas en este ticket hasta ahora.';
        if (row.billableHoursSplitAvailable !== true) {
            return `Total imputado en el ticket: ${this.formatHoursShort(tot)}. Desglose facturable / no facturable no disponible (comprueba el campo No facturable en Imputacion).`;
        }
        const f = Number(row.alreadyImputedFacturableHours) || 0;
        const n = Number(row.alreadyImputedNoFacturableHours) || 0;
        return `Facturable: ${this.formatHoursShort(f)} · No facturable: ${this.formatHoursShort(n)} · Total: ${this.formatHoursShort(tot)}`;
    }

    formatHoursShort(h) {
        const n = Number(h);
        if (!Number.isFinite(n)) return '0 h';
        const t = Math.round(n * 100) / 100;
        return `${t} h`;
    }

    /** Solo cifra (sin unidad); para celdas con «H» aparte. */
    formatHoursNumber(h) {
        const n = Number(h);
        if (!Number.isFinite(n)) return '0';
        return String(Math.round(n * 100) / 100);
    }

    get bulkPanelToggleLabel() {
        return this.bulkPanelOpen ? 'Ocultar plantilla' : 'Mostrar plantilla';
    }

    get showLoadMoreTickets() {
        return this.hasMoreTickets && this.hasRows;
    }

    get entryDateLabel() {
        if (!this.entryDate) {
            return '—';
        }
        if (this.selectedDates.length <= 1) {
            return this.formatDMY(this.entryDate);
        }
        const sorted = [...this.selectedDates].sort();
        const n = sorted.length;
        return `${n} días · ${this.formatDMY(sorted[0])} → ${this.formatDMY(sorted[n - 1])}`;
    }

    get effectiveImputationDatesForChip() {
        const selectedSet = new Set(this.selectedRows);
        const fallbackDates = this.datesForSave;
        const uniq = new Set();
        this.rows.forEach((row) => {
            if (!selectedSet.has(row.caseId)) {
                return;
            }
            this.getRowDatesForSave(row, fallbackDates).forEach((d) => uniq.add(d));
        });
        return [...uniq].sort();
    }

    get pendingChipLabel() {
        const nSel = this.selectedCount;
        if (!nSel) {
            return 'Sin tickets seleccionados';
        }
        const eff = this.effectiveImputationDatesForChip;
        if (!eff.length) {
            return 'Imputación: sin fechas (barra, calendario o por fila)';
        }
        if (eff.length === 1) {
            return `Imputación: ${this.formatDMY(eff[0])}`;
        }
        const sample = eff
            .slice(0, 3)
            .map((d) => this.formatDMY(d))
            .join(', ');
        const tail = eff.length > 3 ? '…' : '';
        return `Imputación (${eff.length} fechas): ${sample}${tail}`;
    }

    isWeekendDate(isoDate) {
        if (!isoDate) return false;
        const d = new Date(`${isoDate}T00:00:00`);
        const day = d.getDay();
        return day === 0 || day === 6;
    }

    isHolidayDate(isoDate) {
        if (!isoDate || typeof isoDate !== 'string' || isoDate.length < 10) return false;
        const mmdd = isoDate.slice(5);
        if (CHILE_FIXED_HOLIDAY_MM_DD.has(mmdd)) {
            return true;
        }
        const raw = this.imputationCenterSettings?.extraHolidaysMmDd;
        if (!raw || typeof raw !== 'string') {
            return false;
        }
        for (const token of raw.split(/[,;\n\r]+/)) {
            const t = String(token || '').trim();
            if (!t) continue;
            const parts = t.replace(/\//g, '-').split('-');
            if (parts.length < 2) continue;
            const mm = String(parts[0]).padStart(2, '0');
            const dd = String(parts[1]).padStart(2, '0');
            if (`${mm}-${dd}` === mmdd) {
                return true;
            }
        }
        return false;
    }

    /**
     * Desglose en vivo de la meta mensual del gráfico (solo UI admin).
     * Lógica en `imputacionesAMSMonitorTransparency` para facilitar pruebas Jest.
     */
    get adminCalcTransparencyModel() {
        return buildAdminCalcTransparencyModel({
            isImputationAdmin: this.isImputationAdmin,
            calendarMonthDate: this.calendarMonthDate,
            imputationCenterSettings: this.imputationCenterSettings,
            monthHasBreakdown: this.monthHasBreakdown,
            monthlyBreakdownIsEstimated: this.monthlyBreakdownIsEstimated
        });
    }

    /** Fila única para `for:each` y remount del input de CSV (LWC no permite `key` suelto en lightning-input). */
    get importFileInputIteratorRows() {
        return [{ key: `import-file-${this.importFileInputKey}` }];
    }

    selectedRowsContainWeekendDates() {
        const selectedSet = new Set(this.selectedRows);
        const rows = this.rows.filter((r) => selectedSet.has(r.caseId));
        const fallbackDates = this.datesForSave;
        for (const row of rows) {
            const rowDates = this.getRowDatesForSave(row, fallbackDates);
            for (const d of rowDates) {
                if (this.isWeekendDate(d)) return true;
            }
        }
        return false;
    }

    selectedRowsContainHolidayDates() {
        const selectedSet = new Set(this.selectedRows);
        const rows = this.rows.filter((r) => selectedSet.has(r.caseId));
        const fallbackDates = this.datesForSave;
        for (const row of rows) {
            const rowDates = this.getRowDatesForSave(row, fallbackDates);
            for (const d of rowDates) {
                if (this.isHolidayDate(d)) {
                    return true;
                }
            }
        }
        return false;
    }

    validateSelectedRows(selectedRowsData) {
        const errors = {};
        selectedRowsData.forEach((row) => {
            const effectiveHours = Number(row.plannedHours);
            if (!Number.isFinite(effectiveHours) || effectiveHours <= 0) {
                errors[row.caseId] = {
                    title: 'Datos incompletos',
                    messages: ['Indica un número de horas mayor que cero en esta fila.']
                };
            }
        });
        return errors;
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    normalizeError(error) {
        if (error?.body?.message) {
            return error.body.message;
        }
        if (Array.isArray(error?.body) && error.body[0]?.message) {
            return error.body[0].message;
        }
        if (error?.body?.pageErrors?.length && error.body.pageErrors[0]?.message) {
            return error.body.pageErrors[0].message;
        }
        if (error?.message) {
            return error.message;
        }
        return 'Ha ocurrido un error inesperado. Vuelve a intentarlo; si se repite, copia el mensaje y contacta con soporte.';
    }
}
