import { LightningElement, track, wire } from 'lwc';
import { getObjectInfo, getPicklistValuesByRecordType } from 'lightning/uiObjectInfoApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import CASE_OBJECT from '@salesforce/schema/Case';
import loadCentroConfig from '@salesforce/apex/CentroImputacionesConfigController.loadCentroConfig';
import saveCentroConfig from '@salesforce/apex/CentroImputacionesConfigController.saveCentroConfig';
import {
    TAB_TYPE_OPTIONS,
    FILTER_LOGIC_OPTIONS,
    CUSTOM_TAB_SLOTS,
    parseTabsFromStorage,
    serializeTabsToJson,
    createEmptyTab,
    createFilterRow,
    validateTabsRows,
    normalizeTicketTabRows,
    previewTabsRows,
    countCustomTabs,
    hasCustomSlot,
    buildCaseFieldOptionsFromObjectInfo
} from './centroImputacionesTicketTabs';
import {
    buildValueEditorState,
    enrichFilterRowForUi,
    joinValuesList
} from './centroImputacionesFieldValuesUtil';
import {
    BADGE_ICON_OPTIONS,
    BILLABLE_EFFECT_OPTIONS,
    BILLABLE_OBJECT_OPTIONS,
    DEFAULT_PANEL_META_COPY,
    DEFAULT_CRITERIO_FACTURABLE,
    DEFAULT_CRITERIO_NO_FACTURABLE,
    DEFAULT_BILLABLE_RULES,
    PANEL_META_FIELD_DEFS,
    parsePanelMetaFromJson,
    serializePanelMetaToJson,
    parseBillableRulesFromJson,
    serializeBillableRulesToJson,
    buildCriteriaSummaryFromRules,
    createBillableFilterRow,
    normalizeSldsIconValue,
    repairPanelMetaCopy
} from './centroImputacionesPanelMeta';

const DEFAULT_HEADER_TAGLINE =
    'Gestiona e importa de forma rapida tus imputaciones de tickets';

const LIST_FIELD_HINT =
    'Un valor por linea, o separados por coma o punto y coma.';

function inferDiagnosticRowKind(source) {
    const s = String(source || '').toLowerCase();
    if (!s) {
        return 'config';
    }
    if (s.startsWith('codigo') || s.includes('lwc ') || s.includes('apex chile')) {
        return 'code';
    }
    if (s.includes('runtime') || s.includes('mes actual')) {
        return 'runtime';
    }
    if (s.includes('css por defecto')) {
        return 'code';
    }
    return 'config';
}

const SOQL_LIMITS_INSTRUCTIVO =
    'Para que sirve: evita que una consulta muy grande agote el limite de Salesforce (SOQL). ' +
    'Ejemplo practico: si "Desglose por dia" = 400, al abrir un dia el centro lee como maximo 400 filas de imputaciones de ese dia; ' +
    'si hay mas, el resto no aparece en el detalle (el total del mes puede seguir sumando hasta "Agregacion mensual"). ' +
    'Valores vacios = defaults del codigo (400 / 20.000 / 200).';

const FALLBACK_RESERVA_HINT =
    'Plan B: solo se usan si la lista principal correspondiente esta vacia. Asi el centro sigue filtrando tickets aunque falte rellenar la lista principal.';

const FALLBACK_ULTIMO_HINT =
    'Plan C: si la lista principal y la de reserva estan vacias, Apex prueba estos valores antes de usar los defaults fijos del codigo.';

const COLOR_DEFAULTS = {
    colorCalDiaVacioFondo: '#F7F8FA',
    colorCalDiaParcialFondo: '#FEF9EC',
    colorCalDiaParcialBorde: '#E6DABE',
    colorCalDiaMetaFondo: '#EFF8F3',
    colorCalDiaMetaBorde: '#B8DCCB',
    colorCalDiaSobreUmbral: '#EA580C',
    colorCalDiaFeriadoFondo: '#FFF1F3',
    colorCalDiaFinSemanaFondo: '#FEF6F8',
    colorCalDiaSeleccionFondo: '#E9F4FF',
    colorCalDiaSeleccionBorde: '#82A7CF',
    colorCalDiaBloqueadoFondo: '#EEF1F6',
    colorGraficoFacturable: '#15803D',
    colorGraficoNoFacturable: '#EA580C',
    colorGraficoMetaProgreso: '#F59E0B',
    colorGraficoImputable: '#2563EB'
};

const DEFAULT_TICKET_TABS_JSON = JSON.stringify(
    [
        {
            id: 'mine',
            label: 'Mis tickets',
            type: 'mine'
        },
        {
            id: 'ams',
            label: 'Gestion AMS',
            type: 'ams',
            supportsCreatedDateFilter: true,
            filterLogic: 'OR'
        }
    ],
    null,
    2
);

const DEFAULT_THRESHOLD_WARN_TEXT =
    'Vas a sumar tiempo en dia(s) que ya superan las {horas} h: {detalle}. Comprueba que no estes cargando el mismo trabajo dos veces.';

const SECTION_SNAPSHOT_KEYS = {
    headerArea: [
        'textoSubtituloCentro',
        'ayudaTextoGeneral',
        'uiMostrarGuiaUso',
        'guiaUsoTexto',
        'ayudaAdminMonitor',
        'uiOcultarImportarCsv',
        'uiOcultarExportarCsv'
    ],
    rulesUi: [
        'ayudaTextoGeneral',
        'textoConfirmacionImputacion',
        'permitirImputarFinSemana',
        'permitirImputarFeriados',
        'textoAvisoFinSemana',
        'textoAvisoFeriado',
        'excepcionFinSemanaUserCampo',
        'excepcionFinSemanaUserValores',
        'imputacionMesesRetro',
        'imputacionMesesAdelante',
        'festivosExtraMmDd',
        'activarAvisoUmbralHoras',
        'umbralAvisoHorasDia',
        'textoAvisoUmbralHoras',
        'filtroServicioTickets',
        'filtroConsultorUserCampo',
        'filtroConsultorUserValores',
        'criteriosFacturableFiltrosJson',
        'criterioCalculoFacturable',
        'criterioCalculoNoFacturable'
    ],
    datesCalendar: [
        'diasFranjaCalendario',
        'umbralHorasDia',
        ...Object.keys(COLOR_DEFAULTS)
    ],
    ticketTable: [
        'pestanasCatalogoTickets',
        'maxTicketsAnclados',
        'tamanoPaginaTickets',
        'limiteSoqlDesgloseDia',
        'limiteSoqlMesAgregacion',
        'limiteSoqlOwnerOpciones',
        'pepSiempreFacturables',
        'pepFallback',
        'motivosGestionAms',
        'motivosFallback',
        'serviciosAms',
        'serviciosFallback',
        'serviciosUltimoRecurso',
        'motivosUltimoRecurso',
        'campoCaseMotivoAms',
        'uiOcultarTabGestionAms',
        'amsFiltroCreadoDiasAtras'
    ],
    rightPanel: [
        'metaFacturablePct',
        'horasMetaDiaLab',
        'uiOcultarPanelTrimestral',
        'colorGraficoFacturable',
        'colorGraficoNoFacturable',
        'colorGraficoMetaProgreso',
        'colorGraficoImputable',
        'panelMetaCopyJson',
        'criterioCalculoFacturable',
        'criterioCalculoNoFacturable',
        'criteriosFacturableFiltrosJson'
    ],
    record: ['recordName', 'origenImputacionDefault']
};

const EXAMPLE_CUSTOM_TAB_JSON = `[
  { "id": "mine", "label": "Mis tickets", "type": "mine" },
  {
    "id": "ams",
    "label": "Gestion AMS",
    "type": "ams",
    "supportsCreatedDateFilter": true,
    "filterLogic": "AND",
    "filters": [
      { "fieldApi": "Reason", "values": "Gestion_Interna, Gestion Interna" },
      { "fieldApi": "Servicio__c", "values": "AMS-SAP" }
    ]
  },
  {
    "id": "custom1",
    "label": "Tickets Apoyo",
    "type": "custom",
    "filterLogic": "OR",
    "filters": [{ "fieldApi": "Reason", "values": "Gestion_Interna" }],
    "hint": "Solo tickets de equipo de apoyo."
  }
]`;

const TICKET_SUB_NAV = [
    { id: 'catalog', label: 'Catalogo pestanas', num: '4a' },
    { id: 'behavior', label: 'Tabla', num: '4b' },
    { id: 'lists', label: 'Listas, reservas y SOQL', num: '4c' }
];

const COLOR_FIELD_KEYS = new Set(Object.keys(COLOR_DEFAULTS));

const COLOR_PICKER_DEFS = [
    { key: 'col-vacio', label: 'Vacio', sub: 'Fondo dia sin horas', field: 'colorCalDiaVacioFondo' },
    { key: 'col-parcial-bg', label: 'Parcial', sub: 'Fondo', field: 'colorCalDiaParcialFondo' },
    { key: 'col-parcial-bd', label: 'Parcial', sub: 'Borde', field: 'colorCalDiaParcialBorde' },
    { key: 'col-meta-bg', label: 'Meta / completo', sub: 'Fondo', field: 'colorCalDiaMetaFondo' },
    { key: 'col-meta-bd', label: 'Meta / completo', sub: 'Borde', field: 'colorCalDiaMetaBorde' },
    { key: 'col-sobre', label: 'Sobre umbral', sub: 'Acento resalte', field: 'colorCalDiaSobreUmbral' },
    { key: 'col-finsem', label: 'Fin de semana', sub: 'Fondo', field: 'colorCalDiaFinSemanaFondo' },
    { key: 'col-feriado', label: 'Feriado', sub: 'Fondo', field: 'colorCalDiaFeriadoFondo' },
    { key: 'col-sel-bg', label: 'Seleccionado', sub: 'Fondo', field: 'colorCalDiaSeleccionFondo' },
    { key: 'col-sel-bd', label: 'Seleccionado', sub: 'Borde', field: 'colorCalDiaSeleccionBorde' },
    { key: 'col-locked', label: 'Bloqueado', sub: 'Fondo', field: 'colorCalDiaBloqueadoFondo' }
];

const CHART_COLOR_PICKER_DEFS = [
    { key: 'graf-fact', label: 'Facturable', sub: 'Dona, barras y leyenda', field: 'colorGraficoFacturable' },
    { key: 'graf-nofact', label: 'No facturable', sub: 'Dona, barras y leyenda', field: 'colorGraficoNoFacturable' },
    {
        key: 'graf-imputable',
        label: 'Imputable',
        sub: 'Leyenda y detalle trimestral',
        field: 'colorGraficoImputable'
    },
    {
        key: 'graf-meta',
        label: 'Meta facturable mensual',
        sub: 'Barra de progreso del panel',
        field: 'colorGraficoMetaProgreso'
    }
];

/** Orden del mapa: registro operativo al final (6). */
const SECTION_NAV = [
    {
        id: 'headerArea',
        num: '1',
        shortLabel: 'Cabecera',
        title: 'Cabecera: titulo, importar, banner',
        desc: 'Ayuda visible, monitor admin y boton Importar CSV.',
        icon: 'utility:page'
    },
    {
        id: 'rulesUi',
        num: '2',
        shortLabel: 'Reglas',
        title: 'Reglas: mensajes, confirmaciones y calculo',
        desc: 'Banner, confirmaciones, ventana de imputacion (excepcion al mes en curso), umbrales y fin de semana o festivos.',
        icon: 'utility:warning'
    },
    {
        id: 'datesCalendar',
        num: '3',
        shortLabel: 'Calendario de Fechas',
        title: 'Calendario de fechas y colores',
        desc: 'Mes de imputacion, barra de dias, colores y festivos.',
        icon: 'utility:event'
    },
    {
        id: 'ticketTable',
        num: '4',
        shortLabel: 'Panel de Tickets',
        title: 'Panel de tickets y catalogo',
        desc: 'Listado central, limites SOQL y listas PEP/motivos/servicios.',
        icon: 'utility:table'
    },
    {
        id: 'rightPanel',
        num: '5',
        shortLabel: 'Graficos',
        title: 'Graficos, metas y mensajes',
        desc: 'Metas del panel, criterios facturables, mensajes por rango y reglas adicionales.',
        icon: 'utility:chart'
    },
    {
        id: 'record',
        num: '6',
        shortLabel: 'Registro op.',
        title: 'Registro operativo',
        desc: 'Etiqueta interna en Salesforce; cambios poco frecuentes.',
        icon: 'utility:record'
    }
];

export default class CentroImputacionesConfig extends LightningElement {
    listFieldHint = LIST_FIELD_HINT;
    soqlLimitsInstructivo = SOQL_LIMITS_INSTRUCTIVO;
    fallbackReservaHint = FALLBACK_RESERVA_HINT;
    filterLogicOptions = FILTER_LOGIC_OPTIONS;
    fallbackUltimoHint = FALLBACK_ULTIMO_HINT;

    @track recordId;
    @track recordName = 'DEFAULT';
    @track pepSiempreFacturables = '';
    @track pepFallback = '';
    @track motivosGestionAms = '';
    @track motivosFallback = '';
    @track serviciosAms = '';
    @track serviciosFallback = '';
    @track maxTicketsAnclados = 5;
    @track diasFranjaCalendario = 14;
    @track umbralHorasDia = 8;
    @track umbralAvisoHorasDia = 10;
    @track tamanoPaginaTickets = 200;
    @track metaFacturablePct = null;
    @track origenImputacionDefault = 'MassiveLWC';
    @track horasMetaDiaLab = null;
    @track amsFiltroCreadoDiasAtras = null;
    @track limiteSoqlDesgloseDia = null;
    @track limiteSoqlMesAgregacion = null;
    @track limiteSoqlOwnerOpciones = null;
    @track ayudaTextoGeneral = '';
    @track uiMostrarGuiaUso = true;
    @track guiaUsoTexto = '';
    @track festivosExtraMmDd = '';
    @track imputacionMesesRetro = null;
    @track imputacionMesesAdelante = null;
    @track serviciosUltimoRecurso = '';
    @track motivosUltimoRecurso = '';
    @track uiOcultarImportarCsv = false;
    @track uiOcultarExportarCsv = false;
    @track uiOcultarPanelTrimestral = false;
    @track uiOcultarTabGestionAms = false;
    @track campoCaseMotivoAms = '';
    @track ayudaAdminMonitor = '';
    @track colorCalDiaVacioFondo = COLOR_DEFAULTS.colorCalDiaVacioFondo;
    @track colorCalDiaParcialFondo = COLOR_DEFAULTS.colorCalDiaParcialFondo;
    @track colorCalDiaParcialBorde = COLOR_DEFAULTS.colorCalDiaParcialBorde;
    @track colorCalDiaMetaFondo = COLOR_DEFAULTS.colorCalDiaMetaFondo;
    @track colorCalDiaMetaBorde = COLOR_DEFAULTS.colorCalDiaMetaBorde;
    @track colorCalDiaSobreUmbral = COLOR_DEFAULTS.colorCalDiaSobreUmbral;
    @track colorCalDiaFeriadoFondo = COLOR_DEFAULTS.colorCalDiaFeriadoFondo;
    @track colorCalDiaFinSemanaFondo = COLOR_DEFAULTS.colorCalDiaFinSemanaFondo;
    @track colorCalDiaSeleccionFondo = COLOR_DEFAULTS.colorCalDiaSeleccionFondo;
    @track colorCalDiaSeleccionBorde = COLOR_DEFAULTS.colorCalDiaSeleccionBorde;
    @track colorCalDiaBloqueadoFondo = COLOR_DEFAULTS.colorCalDiaBloqueadoFondo;
    @track colorGraficoFacturable = COLOR_DEFAULTS.colorGraficoFacturable;
    @track colorGraficoNoFacturable = COLOR_DEFAULTS.colorGraficoNoFacturable;
    @track colorGraficoMetaProgreso = COLOR_DEFAULTS.colorGraficoMetaProgreso;
    @track colorGraficoImputable = COLOR_DEFAULTS.colorGraficoImputable;
    @track pestanasCatalogoTickets = '';
    @track permitirImputarFinSemana = true;
    @track permitirImputarFeriados = true;
    @track textoAvisoFinSemana = '';
    @track textoAvisoUmbralHoras = '';
    @track textoAvisoFeriado = '';
    @track textoConfirmacionImputacion = '';
    @track textoSubtituloCentro = DEFAULT_HEADER_TAGLINE;
    @track excepcionFinSemanaUserCampo = '';
    @track excepcionFinSemanaUserValores = '';
    @track activarAvisoUmbralHoras = true;
    @track filtroServicioTickets = '';
    @track filtroConsultorUserCampo = '';
    @track filtroConsultorUserValores = '';
    userObjectInfo;
    userFieldOptions = [];
    userPicklistFieldValues;
    @track criterioCalculoFacturable = DEFAULT_CRITERIO_FACTURABLE;
    @track criterioCalculoNoFacturable = DEFAULT_CRITERIO_NO_FACTURABLE;
    @track billableCaseFieldApi = DEFAULT_BILLABLE_RULES.caseNoFacturable.fieldApi;
    @track billableCaseValues = DEFAULT_BILLABLE_RULES.caseNoFacturable.values;
    @track billableImputacionIndField = DEFAULT_BILLABLE_RULES.imputacionIndField;
    @track billableImputacionFaValues = DEFAULT_BILLABLE_RULES.imputacionFacturableValues;
    @track billableImputacionNfValues = DEFAULT_BILLABLE_RULES.imputacionNoFacturableValues;
    @track billableCaseExcFieldApi = '';
    @track billableCaseExcValues = '';
    @track billableImputacionExcFieldApi = '';
    @track billableImputacionExcValues = '';
    @track billableExtraFilters = [];
    @track panelMetaCopy = { ...DEFAULT_PANEL_META_COPY };
    @track ticketTabRows = [];
    @track showTicketTabsJsonAdvanced = false;
    @track ticketSubNavId = 'catalog';
    @track selectedTicketTabKey = null;
    caseFieldOptions = [];
    imputacionFieldOptions = [];
    caseObjectInfo = null;
    imputacionObjectInfo = null;
    caseDefaultRecordTypeId;
    imputacionDefaultRecordTypeId;
    casePicklistFieldValues = null;
    imputacionPicklistFieldValues = null;
    badgeIconOptions = BADGE_ICON_OPTIONS;
    billableObjectOptions = BILLABLE_OBJECT_OPTIONS;
    billableEffectOptions = BILLABLE_EFFECT_OPTIONS;
    @track diagnosticRows = [];
    @track _diagnosticCodeRows = [];
    @track _diagnosticRuntimeRows = [];
    @track _diagnosticConfigRows = [];
    @track loaded = false;
    @track canEdit = false;
    @track leadMessage = '';
    @track isSaving = false;
    @track diagnosticsModalOpen = false;
    @track recordNameEditing = false;
    @track origenImputacionEditing = false;

    @track activeNavId = 'headerArea';

    savedSnapshot = null;
    /** Sello incremental: cualquier mutación bumpea este número; isDirty memoiza por su valor. */
    _changeTick = 0;
    _lastDirtyTick = -1;
    _lastDirtyResult = false;

    connectedCallback() {
        this.refresh();
    }

    get mapZones() {
        return SECTION_NAV.map((s) => ({
            ...s,
            mapClass:
                'cc-map__zone' + (this.activeNavId === s.id ? ' cc-map__zone--active' : '')
        }));
    }

    get activeSection() {
        return SECTION_NAV.find((s) => s.id === this.activeNavId) || SECTION_NAV[0];
    }

    get activeSectionTitle() {
        return this.activeSection.title;
    }

    get activeSectionDesc() {
        return this.activeSection.desc;
    }

    get hasDiagnostics() {
        return (
            (Array.isArray(this.diagnosticCodeRows) && this.diagnosticCodeRows.length > 0) ||
            (Array.isArray(this.diagnosticConfigRows) && this.diagnosticConfigRows.length > 0) ||
            (Array.isArray(this.diagnosticRuntimeRows) && this.diagnosticRuntimeRows.length > 0)
        );
    }

    get diagnosticCodeRows() {
        return this._diagnosticCodeRows || [];
    }

    get diagnosticRuntimeRows() {
        return this._diagnosticRuntimeRows || [];
    }

    get diagnosticConfigRows() {
        return this._diagnosticConfigRows || [];
    }

    get hasDiagnosticCodeRows() {
        return this.diagnosticCodeRows.length > 0;
    }

    get hasDiagnosticRuntimeRows() {
        return this.diagnosticRuntimeRows.length > 0;
    }

    get hasDiagnosticConfigRows() {
        return this.diagnosticConfigRows.length > 0;
    }

    get showHeaderArea() {
        return this.activeNavId === 'headerArea';
    }
    get showRulesUi() {
        return this.activeNavId === 'rulesUi';
    }
    get showDatesCalendar() {
        return this.activeNavId === 'datesCalendar';
    }
    get showTicketTable() {
        return this.activeNavId === 'ticketTable';
    }

    @wire(getObjectInfo, { objectApiName: CASE_OBJECT })
    wiredCaseObjectInfo({ data }) {
        if (data) {
            this.caseObjectInfo = data;
            this.caseDefaultRecordTypeId = data.defaultRecordTypeId;
            this.caseFieldOptions = buildCaseFieldOptionsFromObjectInfo(data);
        }
    }

    @wire(getObjectInfo, { objectApiName: 'Imputacion__c' })
    wiredImputacionObjectInfo({ data }) {
        if (data) {
            this.imputacionObjectInfo = data;
            this.imputacionDefaultRecordTypeId = data.defaultRecordTypeId;
            this.imputacionFieldOptions = buildCaseFieldOptionsFromObjectInfo(data);
        }
    }

    @wire(getObjectInfo, { objectApiName: 'User' })
    wiredUserObjectInfo({ data }) {
        if (data) {
            this.userObjectInfo = data;
            this.userFieldOptions = buildCaseFieldOptionsFromObjectInfo(data);
        }
    }

    @wire(getPicklistValuesByRecordType, {
        objectApiName: CASE_OBJECT,
        recordTypeId: '$caseDefaultRecordTypeId'
    })
    wiredCasePicklists({ data }) {
        if (data) {
            this.casePicklistFieldValues = data.picklistFieldValues;
        }
    }

    @wire(getPicklistValuesByRecordType, {
        objectApiName: 'Imputacion__c',
        recordTypeId: '$imputacionDefaultRecordTypeId'
    })
    wiredImputacionPicklists({ data }) {
        if (data) {
            this.imputacionPicklistFieldValues = data.picklistFieldValues;
        }
    }

    get ticketSubNavItems() {
        return TICKET_SUB_NAV.map((item) => ({
            ...item,
            className:
                'cc-subnav__btn' +
                (this.ticketSubNavId === item.id ? ' cc-subnav__btn--active' : '')
        }));
    }

    get showTicketSubCatalog() {
        return this.ticketSubNavId === 'catalog';
    }

    get showTicketSubBehavior() {
        return this.ticketSubNavId === 'behavior';
    }

    get showTicketSubLists() {
        return this.ticketSubNavId === 'lists';
    }

    get custom1AddDisabled() {
        return hasCustomSlot(this.ticketTabRows, 'custom1') || countCustomTabs(this.ticketTabRows) >= 2;
    }

    get custom2AddDisabled() {
        return hasCustomSlot(this.ticketTabRows, 'custom2') || countCustomTabs(this.ticketTabRows) >= 2;
    }

    get customTabsFull() {
        return countCustomTabs(this.ticketTabRows) >= 2;
    }
    get amsLegacyBlockRemoved() {
        return false;
    }

    get uiShowQuarterPanel() {
        return this.uiOcultarPanelTrimestral !== true;
    }

    get showRightPanel() {
        return this.activeNavId === 'rightPanel';
    }
    get showRecord() {
        return this.activeNavId === 'record';
    }

    get recordNameLocked() {
        return !this.recordNameEditing;
    }

    get recordNameEditLabel() {
        return this.recordNameEditing ? 'Bloquear edicion' : 'Editar nombre';
    }

    get origenImputacionLocked() {
        return !this.origenImputacionEditing;
    }

    get origenImputacionEditLabel() {
        return this.origenImputacionEditing ? 'Bloquear edicion' : 'Editar origen';
    }

    tabTypeOptions = TAB_TYPE_OPTIONS;

    get panelMetaFieldItems() {
        const copy = this.panelMetaCopy || DEFAULT_PANEL_META_COPY;
        return PANEL_META_FIELD_DEFS.map((d) => {
            const raw = copy[d.key] != null ? copy[d.key] : DEFAULT_PANEL_META_COPY[d.key];
            const isIcon = d.kind === 'icon';
            return {
                key: d.key,
                label: d.label,
                kind: d.kind || 'text',
                isIcon,
                isText: !isIcon,
                value: isIcon ? normalizeSldsIconValue(raw) : raw
            };
        });
    }

    get panelMetaMessageItems() {
        return this.panelMetaFieldItems.filter((i) => String(i.key).startsWith('msg'));
    }

    get panelMetaBadgeItems() {
        return this.panelMetaFieldItems.filter((i) => String(i.key).startsWith('badge'));
    }

    get billableCaseValuesUi() {
        return this.enrichBillableValueUi(
            this.billableCaseFieldApi,
            this.billableCaseValues,
            'Case'
        );
    }

    get billableCaseExcValuesUi() {
        return this.enrichBillableValueUi(
            this.billableCaseExcFieldApi,
            this.billableCaseExcValues,
            'Case'
        );
    }

    get billableImputacionExcValuesUi() {
        return this.enrichBillableValueUi(
            this.billableImputacionExcFieldApi,
            this.billableImputacionExcValues,
            'Imputacion__c'
        );
    }

    get excepcionFinSemanaUserValoresUi() {
        return this.enrichBillableValueUi(
            this.excepcionFinSemanaUserCampo,
            this.excepcionFinSemanaUserValores,
            'User'
        );
    }

    get filtroConsultorUserValoresUi() {
        return this.enrichBillableValueUi(
            this.filtroConsultorUserCampo,
            this.filtroConsultorUserValores,
            'User'
        );
    }

    enrichBillableValueUi(fieldApi, valuesRaw, objectApi) {
        const objectInfo =
            objectApi === 'Case'
                ? this.caseObjectInfo
                : objectApi === 'User'
                  ? this.userObjectInfo
                  : this.imputacionObjectInfo;
        const picklists =
            objectApi === 'Case'
                ? this.casePicklistFieldValues
                : objectApi === 'User'
                  ? this.userPicklistFieldValues
                  : this.imputacionPicklistFieldValues;
        const editor = buildValueEditorState(fieldApi, valuesRaw, objectInfo, picklists);
        return {
            ...editor,
            usePicklist: editor.valueMode === 'picklist',
            useMultipicklist: editor.valueMode === 'multipicklist',
            useTextValues: editor.valueMode === 'text'
        };
    }

    get billableExtraFilterRows() {
        return (this.billableExtraFilters || []).map((f, index) => {
            const valueUi = this.enrichBillableValueUi(f.fieldApi, f.values, f.objectApi);
            return {
                ...f,
                fkey: f._fkey,
                index: index + 1,
                isCase: f.objectApi === 'Case',
                fieldOptions: f.objectApi === 'Case' ? this.caseFieldOptions : this.imputacionFieldOptions,
                canRemove: (this.billableExtraFilters || []).length > 0,
                ...valueUi
            };
        });
    }

    get billableExtraFiltersFull() {
        return (this.billableExtraFilters || []).length >= 8;
    }

    get showDuplicateReferenceBlock() {
        return false;
    }

    get ticketTabsPreview() {
        return previewTabsRows(this.ticketTabRows);
    }

    get ticketTabSidebarItems() {
        return (this.ticketTabRows || []).map((row, index) => ({
            key: row._key,
            rowKey: row._key,
            label: row.label || row.id,
            id: row.id,
            typeLabel:
                row.type === 'mine'
                    ? 'mine'
                    : row.type === 'ams'
                      ? 'ams'
                      : row.id,
            hidden: row.hidden === true,
            hiddenLabel: row.hidden ? 'Oculta' : 'Visible',
            selected: (this.selectedTicketTabKey || this.ticketTabRows[0]?._key) === row._key,
            itemClass:
                'cc-tab-sidebar__item' +
                ((this.selectedTicketTabKey || this.ticketTabRows[0]?._key) === row._key
                    ? ' cc-tab-sidebar__item--active'
                    : ''),
            index
        }));
    }

    get ticketTabEditorRows() {
        const selectedKey = this.selectedTicketTabKey || this.ticketTabRows[0]?._key;
        const rows = (this.ticketTabRows || []).filter((r) => !selectedKey || r._key === selectedKey);
        return rows.map((row, index) => ({
            ...row,
            rowKey: row._key,
            index,
            isMine: row.type === 'mine',
            isCustom: row.type === 'custom',
            isAms: row.type === 'ams',
            showsFilters: row.type === 'ams' || row.type === 'custom',
            typeLabel:
                row.type === 'mine'
                    ? 'MIS TICKETS'
                    : row.type === 'ams'
                      ? 'GESTION AMS'
                      : 'PERSONALIZADA',
            moveUpDisabled: index === 0,
            moveDownDisabled: index >= this.ticketTabRows.length - 1,
            deleteDisabled: row.type === 'mine' || row.id === 'ams',
            idLocked: row.type === 'mine' || row.type === 'ams',
            showFilterLogic: (row.filters || []).length > 1,
            filterRows: (row.filters || []).map((f, fi) =>
                enrichFilterRowForUi(
                    {
                        fkey: f._fkey,
                        fieldApi: f.fieldApi,
                        values: f.values,
                        matchEmpty: f.matchEmpty === true,
                        canRemoveFilter:
                            row.type === 'ams'
                                ? (row.filters || []).length >= 1
                                : (row.filters || []).length > 1,
                        filterIndex: fi + 1
                    },
                    this.caseObjectInfo,
                    this.casePicklistFieldValues
                )
            )
        }));
    }

    statusPill(label, tone, key) {
        return {
            key,
            label,
            tone,
            statusClass: `cc-status-pill cc-status-pill--${tone}`
        };
    }

    get uiImportCsvVisible() {
        return !this.uiOcultarImportarCsv;
    }

    get uiExportCsvVisible() {
        return !this.uiOcultarExportarCsv;
    }

    handleToggleImportCsvVisible(event) {
        this.uiOcultarImportarCsv = !event.detail.checked;
        this.markDirty();
    }

    handleToggleExportCsvVisible(event) {
        this.uiOcultarExportarCsv = !event.detail.checked;
        this.markDirty();
    }

    handleToggleShowQuarterPanel(event) {
        this.uiOcultarPanelTrimestral = !event.detail.checked;
        this.markDirty();
    }

    get headerStatusPills() {
        return [
            this.statusPill('Visible para usuarios', 'success', 'vis'),
            this.statusPill(
                this.uiOcultarImportarCsv ? 'Importar CSV oculto' : 'Importar CSV visible',
                this.uiOcultarImportarCsv ? 'neutral' : 'success',
                'csv-import'
            ),
            this.statusPill(
                this.uiOcultarExportarCsv ? 'Exportar CSV oculto' : 'Exportar CSV visible',
                this.uiOcultarExportarCsv ? 'neutral' : 'success',
                'csv-export'
            )
        ];
    }

    get rulesStatusPills() {
        return [
            this.statusPill(
                this.permitirImputarFinSemana ? 'FDS permitido' : 'FDS bloqueado',
                this.permitirImputarFinSemana ? 'success' : 'danger',
                'fds'
            ),
            this.statusPill(
                this.permitirImputarFeriados ? 'Festivos permitidos' : 'Festivos bloqueados',
                this.permitirImputarFeriados ? 'success' : 'danger',
                'fer'
            ),
            this.statusPill(
                `Imputar -${this.imputacionMesesRetro ?? 0}/+${this.imputacionMesesAdelante ?? 0} mes (excepcion)`,
                'info',
                'win'
            ),
            this.statusPill(`Umbral ${this.umbralAvisoHorasDia ?? 10} h`, 'warn', 'thr')
        ];
    }

    get calendarStatusPills() {
        return [
            this.statusPill(`${this.diasFranjaCalendario ?? 14} dias en franja`, 'info', 'd'),
            this.statusPill(`Umbral ${this.umbralHorasDia ?? 8} h`, 'warn', 'h'),
            this.statusPill('8 estados de color', 'success', 'c')
        ];
    }

    get ticketsStatusPills() {
        const visible = (this.ticketTabRows || []).filter((t) => !t.hidden).length;
        const hidden = (this.ticketTabRows || []).filter((t) => t.hidden).length;
        return [
            this.statusPill(`${visible} pestana(s) visible(s)`, 'info', 'v'),
            this.statusPill(`${hidden} oculta(s)`, hidden ? 'warn' : 'neutral', 'h')
        ];
    }

    get chartsStatusPills() {
        const meta =
            this.metaFacturablePct != null && this.metaFacturablePct !== ''
                ? `Meta ${this.metaFacturablePct}%`
                : 'Meta sin configurar';
        const jornada =
            this.horasMetaDiaLab != null && this.horasMetaDiaLab !== ''
                ? `${this.horasMetaDiaLab} h dia laboral`
                : 'Jornada sin configurar';
        const faNf =
            (this.billableImputacionIndField || '').trim() &&
            (this.billableImputacionFaValues || '').trim() &&
            (this.billableImputacionNfValues || '').trim()
                ? 'FA/NF configurado'
                : 'FA/NF incompleto';
        return [
            this.statusPill(meta, this.metaFacturablePct != null ? 'info' : 'warn', 'm'),
            this.statusPill(jornada, this.horasMetaDiaLab != null ? 'success' : 'warn', 'j'),
            this.statusPill(faNf, faNf.includes('configurado') ? 'success' : 'warn', 'r'),
            this.statusPill('5 rangos de mensaje', 'neutral', 'rng')
        ];
    }

    get activeSectionStatusPills() {
        if (this.activeNavId === 'headerArea') return this.headerStatusPills;
        if (this.activeNavId === 'rulesUi') return this.rulesStatusPills;
        if (this.activeNavId === 'datesCalendar') return this.calendarStatusPills;
        if (this.activeNavId === 'ticketTable') return this.ticketsStatusPills;
        if (this.activeNavId === 'rightPanel') return this.chartsStatusPills;
        return [];
    }

    get panelMetaRangeItems() {
        const copy = this.panelMetaCopy || DEFAULT_PANEL_META_COPY;
        const ranges = [
            { key: '0', range: '0-39%', msgKey: 'msg0', badgeKey: 'badge0', tone: 'danger' },
            { key: '40', range: '40-69%', msgKey: 'msg40', badgeKey: 'badge40', tone: 'warn' },
            { key: '70', range: '70-84%', msgKey: 'msg70', badgeKey: 'badge70', tone: 'info' },
            { key: '85', range: '85-99%', msgKey: 'msg85', badgeKey: 'badge85', tone: 'success' },
            { key: '100', range: '100%+', msgKey: 'msg100', badgeKey: 'badge100', tone: 'purple' }
        ];
        return ranges.map((r) => {
            const iconKey = `badgeIcon${r.key}`;
            return {
                ...r,
                message: copy[r.msgKey] || '',
                badge: copy[r.badgeKey] || '',
                icon: copy[iconKey] || 'utility:target',
                msgField: r.msgKey,
                badgeField: r.badgeKey,
                iconField: iconKey,
                pillClass: `cc-range-pill cc-range-pill--${r.tone}`,
                summaryPreview: (copy[r.msgKey] || '').slice(0, 72)
            };
        });
    }

    get hasTicketTabRows() {
        return Array.isArray(this.ticketTabRows) && this.ticketTabRows.length > 0;
    }

    get ticketTabsAdvancedToggleLabel() {
        return this.showTicketTabsJsonAdvanced ? 'Ocultar JSON avanzado' : 'Ver JSON avanzado';
    }

    get ticketTabsPreviewIsError() {
        return (this.ticketTabsPreview || '').startsWith('Error:');
    }

    get ticketTabsPreviewClass() {
        return (
            'cc-callout cc-callout--preview' +
            (this.ticketTabsPreviewIsError ? ' cc-callout--error' : '')
        );
    }

    get footerBarClass() {
        return 'cc-section-footer' + (this.isDirty ? ' cc-section-footer--dirty' : '');
    }

    get colorPickerItems() {
        return COLOR_PICKER_DEFS.map((d) => {
            const value = this[d.field] || COLOR_DEFAULTS[d.field];
            return {
                key: d.key,
                label: d.label,
                sub: d.sub || '',
                field: d.field,
                value,
                swatchStyle: `background-color: ${value}`
            };
        });
    }

    get chartColorPickerItems() {
        return CHART_COLOR_PICKER_DEFS.map((d) => {
            const value = this[d.field] || COLOR_DEFAULTS[d.field];
            return {
                key: d.key,
                label: d.label,
                sub: d.sub || '',
                field: d.field,
                value,
                swatchStyle: `background-color: ${value}`
            };
        });
    }

    /**
     * Comparación cara (JSON.stringify del payload). Antes se ejecutaba en cada render (badge, footer,
     * saveDisabled, discardDisabled). Ahora se memoiza por `_changeTick`: solo recomputa cuando un
     * handler llamó a `markDirty()`. Si la comparación nunca se invalida, el resultado en caché es
     * reutilizado sin coste.
     */
    get isDirty() {
        if (!this.savedSnapshot || !this.canEdit) {
            return false;
        }
        if (this._lastDirtyTick === this._changeTick) {
            return this._lastDirtyResult;
        }
        const computed = JSON.stringify(this.buildPayload()) !== this.savedSnapshot;
        this._lastDirtyTick = this._changeTick;
        this._lastDirtyResult = computed;
        return computed;
    }

    /** Cualquier handler que mutate estado del centro debe llamar a esto. */
    markDirty() {
        this._changeTick += 1;
    }

    get dirtyBadgeClass() {
        return 'cc-dirty-badge' + (this.isDirty ? ' cc-dirty-badge--on' : '');
    }

    get saveDisabled() {
        return this.isSaving || !this.isDirty;
    }

    get discardDisabled() {
        return this.isSaving || !this.isDirty;
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    readBillableRulesFromComponent() {
        return {
            caseNoFacturable: {
                fieldApi: this.billableCaseFieldApi || '',
                values: this.billableCaseValues || ''
            },
            caseExcepcionFacturable: {
                fieldApi: this.billableCaseExcFieldApi || '',
                values: this.billableCaseExcValues || ''
            },
            imputacionIndField: this.billableImputacionIndField || '',
            imputacionFacturableValues: this.billableImputacionFaValues || '',
            imputacionNoFacturableValues: this.billableImputacionNfValues || '',
            imputacionExcepcionFacturable: {
                fieldApi: this.billableImputacionExcFieldApi || '',
                values: this.billableImputacionExcValues || ''
            },
            extraFilters: (this.billableExtraFilters || []).map((f) => ({
                objectApi: f.objectApi,
                fieldApi: f.fieldApi,
                values: f.values,
                effect: f.effect
            }))
        };
    }

    syncBillableCriteriaFromRules() {
        const summary = buildCriteriaSummaryFromRules(this.readBillableRulesFromComponent());
        this.criterioCalculoFacturable = summary.facturable;
        this.criterioCalculoNoFacturable = summary.noFacturable;
    }

    applyBillableRulesFromStored(jsonRaw) {
        const rules = parseBillableRulesFromJson(jsonRaw);
        this.billableCaseFieldApi = rules.caseNoFacturable.fieldApi;
        this.billableCaseValues = rules.caseNoFacturable.values;
        this.billableCaseExcFieldApi = rules.caseExcepcionFacturable.fieldApi;
        this.billableCaseExcValues = rules.caseExcepcionFacturable.values;
        this.billableImputacionIndField = rules.imputacionIndField;
        this.billableImputacionFaValues = rules.imputacionFacturableValues;
        this.billableImputacionNfValues = rules.imputacionNoFacturableValues;
        this.billableImputacionExcFieldApi = rules.imputacionExcepcionFacturable.fieldApi;
        this.billableImputacionExcValues = rules.imputacionExcepcionFacturable.values;
        this.billableExtraFilters = rules.extraFilters || [];
        this.syncBillableCriteriaFromRules();
    }

    buildPayload() {
        this.syncBillableCriteriaFromRules();
        this.syncAmsGlobalFlagsFromCatalog();
        const payload = {
            recordId: this.recordId || null,
            recordName: this.recordName,
            pepSiempreFacturables: this.pepSiempreFacturables,
            pepFallback: this.pepFallback,
            motivosGestionAms: this.motivosGestionAms,
            motivosFallback: this.motivosFallback,
            serviciosAms: this.serviciosAms,
            serviciosFallback: this.serviciosFallback,
            maxTicketsAnclados: this.maxTicketsAnclados,
            diasFranjaCalendario: this.diasFranjaCalendario,
            umbralHorasDia: this.umbralHorasDia,
            umbralAvisoHorasDia: this.umbralAvisoHorasDia,
            tamanoPaginaTickets: this.tamanoPaginaTickets,
            metaFacturablePct: this.metaFacturablePct,
            origenImputacionDefault: this.origenImputacionDefault,
            horasMetaDiaLab: this.horasMetaDiaLab,
            amsFiltroCreadoDiasAtras: this.amsFiltroCreadoDiasAtras,
            limiteSoqlDesgloseDia: this.limiteSoqlDesgloseDia,
            limiteSoqlMesAgregacion: this.limiteSoqlMesAgregacion,
            limiteSoqlOwnerOpciones: this.limiteSoqlOwnerOpciones,
            ayudaTextoGeneral: this.ayudaTextoGeneral,
            uiMostrarGuiaUso: this.uiMostrarGuiaUso,
            guiaUsoTexto: this.guiaUsoTexto,
            festivosExtraMmDd: this.festivosExtraMmDd,
            imputacionMesesRetro: this.imputacionMesesRetro,
            imputacionMesesAdelante: this.imputacionMesesAdelante,
            serviciosUltimoRecurso: this.serviciosUltimoRecurso,
            motivosUltimoRecurso: this.motivosUltimoRecurso,
            uiOcultarImportarCsv: this.uiOcultarImportarCsv,
            uiOcultarExportarCsv: this.uiOcultarExportarCsv,
            uiOcultarPanelTrimestral: this.uiOcultarPanelTrimestral,
            uiOcultarTabGestionAms: this.uiOcultarTabGestionAms,
            campoCaseMotivoAms: this.campoCaseMotivoAms,
            ayudaAdminMonitor: this.ayudaAdminMonitor,
            colorCalDiaVacioFondo: this.colorCalDiaVacioFondo,
            colorCalDiaParcialFondo: this.colorCalDiaParcialFondo,
            colorCalDiaParcialBorde: this.colorCalDiaParcialBorde,
            colorCalDiaMetaFondo: this.colorCalDiaMetaFondo,
            colorCalDiaMetaBorde: this.colorCalDiaMetaBorde,
            colorCalDiaSobreUmbral: this.colorCalDiaSobreUmbral,
            colorCalDiaFeriadoFondo: this.colorCalDiaFeriadoFondo,
            colorCalDiaFinSemanaFondo: this.colorCalDiaFinSemanaFondo,
            colorCalDiaSeleccionFondo: this.colorCalDiaSeleccionFondo,
            colorCalDiaSeleccionBorde: this.colorCalDiaSeleccionBorde,
            colorCalDiaBloqueadoFondo: normalizeHexColor(this.colorCalDiaBloqueadoFondo),
            colorGraficoFacturable: this.colorGraficoFacturable,
            colorGraficoNoFacturable: this.colorGraficoNoFacturable,
            colorGraficoMetaProgreso: this.colorGraficoMetaProgreso,
            colorGraficoImputable: this.colorGraficoImputable,
            pestanasCatalogoTickets: this.pestanasCatalogoTickets,
            permitirImputarFinSemana: this.permitirImputarFinSemana === true,
            permitirImputarFeriados: this.permitirImputarFeriados === true,
            textoAvisoFinSemana: this.textoAvisoFinSemana,
            textoAvisoUmbralHoras: this.textoAvisoUmbralHoras,
            textoAvisoFeriado: this.textoAvisoFeriado,
            textoConfirmacionImputacion: this.textoConfirmacionImputacion,
            panelMetaCopyJson: serializePanelMetaToJson(this.panelMetaCopy),
            criterioCalculoFacturable: this.criterioCalculoFacturable,
            criterioCalculoNoFacturable: this.criterioCalculoNoFacturable,
            textoSubtituloCentro: this.textoSubtituloCentro,
            excepcionFinSemanaUserCampo: this.excepcionFinSemanaUserCampo,
            excepcionFinSemanaUserValores: this.excepcionFinSemanaUserValores,
            activarAvisoUmbralHoras: this.activarAvisoUmbralHoras !== false,
            filtroServicioTickets: this.filtroServicioTickets,
            filtroConsultorUserCampo: this.filtroConsultorUserCampo,
            filtroConsultorUserValores: this.filtroConsultorUserValores,
            criteriosFacturableFiltrosJson: serializeBillableRulesToJson(this.readBillableRulesFromComponent())
        };
        COLOR_FIELD_KEYS.forEach((k) => {
            payload[k] = normalizeHexColor(payload[k]);
        });
        return payload;
    }

    syncTicketTabsFromRows() {
        this.pestanasCatalogoTickets = serializeTabsToJson(this.ticketTabRows);
    }

    loadTicketTabsFromStorage() {
        this.ticketTabRows = normalizeTicketTabRows(parseTabsFromStorage(this.pestanasCatalogoTickets));
        if (!this.selectedTicketTabKey && this.ticketTabRows.length) {
            this.selectedTicketTabKey = this.ticketTabRows[0]._key;
        }
    }

    handleSelectTicketTab(event) {
        this.selectedTicketTabKey = event.currentTarget.dataset.key;
    }

    handleRestoreActiveSection() {
        if (!this.savedSnapshot) {
            return;
        }
        try {
            const snap = JSON.parse(this.savedSnapshot);
            const keys = SECTION_SNAPSHOT_KEYS[this.activeNavId] || [];
            keys.forEach((k) => {
                if (snap[k] === undefined) {
                    return;
                }
                this[k] = snap[k];
            });
            if (this.activeNavId === 'ticketTable' && snap.pestanasCatalogoTickets != null) {
                this.pestanasCatalogoTickets = snap.pestanasCatalogoTickets;
                this.loadTicketTabsFromStorage();
            }
            if (this.activeNavId === 'rightPanel') {
                this.applyPanelMetaFromStored(
                    snap.panelMetaCopyJson,
                    snap.criterioCalculoFacturable,
                    snap.criterioCalculoNoFacturable,
                    snap.criteriosFacturableFiltrosJson
                );
            }
            this.markDirty();
            this.toast('Seccion restaurada', 'Valores de esta seccion recuperados del ultimo estado guardado.', 'info');
        } catch (e) {
            this.toast('Error', 'No se pudo restaurar la seccion.', 'error');
        }
    }

    handleSectionCancel() {
        this.handleDiscard();
    }

    handleRestoreDefaultTicketTabs() {
        const parsed = JSON.parse(DEFAULT_TICKET_TABS_JSON);
        const ams = parsed.find((t) => t.id === 'ams');
        if (ams) {
            const motivos = (this.motivosGestionAms || '').trim();
            const servicios = (this.serviciosAms || '').trim();
            const campo = (this.campoCaseMotivoAms || 'Reason').trim();
            const filters = [{ fieldApi: campo, values: motivos }];
            if (servicios) {
                filters.push({ fieldApi: 'Servicio__c', values: servicios });
            }
            ams.filters = filters;
            ams.filterLogic = filters.length > 1 ? 'AND' : 'AND';
        }
        this.pestanasCatalogoTickets = JSON.stringify(parsed, null, 2);
        this.loadTicketTabsFromStorage();
        this.markDirty();
    }

    handleTicketSubNav(event) {
        this.ticketSubNavId = event.currentTarget.dataset.id;
    }

    handleInsertCustomTabExample() {
        this.pestanasCatalogoTickets = EXAMPLE_CUSTOM_TAB_JSON;
        this.loadTicketTabsFromStorage();
        this.markDirty();
    }

    handleToggleTicketTabsJsonAdvanced() {
        this.showTicketTabsJsonAdvanced = !this.showTicketTabsJsonAdvanced;
    }

    handleAddCustomTab() {
        if (countCustomTabs(this.ticketTabRows) >= 2) {
            this.toast('Limite', 'Solo puedes tener dos pestanas personalizadas.', 'warning');
            return;
        }
        const slot = CUSTOM_TAB_SLOTS.find((s) => !hasCustomSlot(this.ticketTabRows, s));
        if (!slot) {
            this.toast('Limite', 'Solo puedes tener dos pestanas personalizadas.', 'warning');
            return;
        }
        const rows = [...(this.ticketTabRows || []), createEmptyTab(slot)];
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleRemoveTicketTab(event) {
        const key = event.currentTarget.dataset.key;
        const rows = (this.ticketTabRows || []).filter((r) => r._key !== key);
        if (!rows.some((r) => r.id === 'mine')) {
            this.toast('No permitido', 'Debe quedar al menos la pestana "mine".', 'warning');
            return;
        }
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleMoveTicketTab(event) {
        const key = event.currentTarget.dataset.key;
        const dir = event.currentTarget.dataset.dir;
        const rows = [...(this.ticketTabRows || [])];
        const idx = rows.findIndex((r) => r._key === key);
        if (idx < 0) {
            return;
        }
        const swap = dir === 'up' ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= rows.length) {
            return;
        }
        const tmp = rows[idx];
        rows[idx] = rows[swap];
        rows[swap] = tmp;
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleTicketTabFieldChange(event) {
        const key = event.currentTarget.dataset.key;
        const field = event.currentTarget.dataset.field;
        let value =
            event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
        if (field === 'supportsCreatedDateFilter' || field === 'hidden') {
            value = !!event.detail.checked;
        }
        if (field === 'createdDateDaysBack') {
            value = value === '' || value == null ? null : Number(value);
        }
        const rows = (this.ticketTabRows || []).map((r) => {
            if (r._key !== key) {
                return r;
            }
            const next = { ...r, [field]: value };
            if (field === 'type') {
                next.type = value;
                if (value === 'mine') {
                    next.id = 'mine';
                    next.supportsCreatedDateFilter = false;
                    next.filters = [];
                } else if (value === 'ams') {
                    if (next.id === 'mine' || next.id === 'custom1' || next.id === 'custom2') {
                        next.id = 'ams';
                    }
                    next.supportsCreatedDateFilter = true;
                    if (!next.filters || !next.filters.length) {
                        next.filters = [];
                    }
                } else if (value === 'custom') {
                    if (next.id === 'mine' || next.id === 'ams') {
                        next.id = !hasCustomSlot(this.ticketTabRows, 'custom1') ? 'custom1' : 'custom2';
                    }
                    if (!next.filters || !next.filters.length) {
                        next.filters = [createFilterRow('Reason', '')];
                    }
                }
            }
            if (field === 'id' && next.type !== 'mine' && next.type !== 'ams') {
                next.id = String(value || '')
                    .trim()
                    .toLowerCase()
                    .replace(/\s+/g, '_');
            }
            return next;
        });
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleAddTabFilter(event) {
        const tabKey = event.currentTarget.dataset.key;
        const rows = (this.ticketTabRows || []).map((r) => {
            if (r._key !== tabKey) return r;
            const filters = [...(r.filters || []), createFilterRow()];
            if (filters.length > 5) {
                this.toast('Limite', 'Maximo 5 filtros por pestana.', 'warning');
                return r;
            }
            return { ...r, filters };
        });
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleRemoveTabFilter(event) {
        const tabKey = event.currentTarget.dataset.key;
        const fkey = event.currentTarget.dataset.fkey;
        const rows = (this.ticketTabRows || []).map((r) => {
            if (r._key !== tabKey) return r;
            const filters = (r.filters || []).filter((f) => f._fkey !== fkey);
            if (r.type === 'ams') {
                return { ...r, filters };
            }
            return { ...r, filters: filters.length ? filters : [createFilterRow()] };
        });
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleTabFilterFieldChange(event) {
        const tabKey = event.currentTarget.dataset.key;
        const fkey = event.currentTarget.dataset.fkey;
        const field = event.currentTarget.dataset.field;
        let value =
            event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
        if (field === 'matchEmpty') {
            value = !!event.detail.checked;
        } else if (field === 'values' && Array.isArray(value)) {
            value = joinValuesList(value);
        }
        const rows = (this.ticketTabRows || []).map((r) => {
            if (r._key !== tabKey) return r;
            const filters = (r.filters || []).map((f) => {
                if (f._fkey !== fkey) return f;
                const next = { ...f, [field]: value };
                if (field === 'fieldApi') {
                    next.values = '';
                }
                return next;
            });
            return { ...r, filters };
        });
        this.ticketTabRows = rows;
        this.syncTicketTabsFromRows();
        this.markDirty();
    }

    handleBillablePicklistValuesChange(event) {
        const targetField = event.currentTarget.dataset.targetField;
        let v = event.detail.value;
        if (Array.isArray(v)) {
            v = joinValuesList(v);
        }
        if (targetField === 'billableCaseVals') {
            this.billableCaseValues = v;
        } else if (targetField === 'billableCaseExcVals') {
            this.billableCaseExcValues = v;
        } else if (targetField === 'billableImpExcVals') {
            this.billableImputacionExcValues = v;
        }
        this.syncBillableCriteriaFromRules();
        this.markDirty();
    }

    handleUserRulePicklistValuesChange(event) {
        const targetField = event.currentTarget.dataset.targetField;
        let v = event.detail.value;
        if (Array.isArray(v)) {
            v = joinValuesList(v);
        }
        if (targetField === 'excFinSemUserVals') {
            this.excepcionFinSemanaUserValores = v;
        } else if (targetField === 'filtroConsUserVals') {
            this.filtroConsultorUserValores = v;
        }
        this.markDirty();
    }

    applyPanelMetaDefaults() {
        this.panelMetaCopy = repairPanelMetaCopy({ ...DEFAULT_PANEL_META_COPY });
        this.applyBillableRulesFromStored('');
    }

    applyPanelMetaFromStored(jsonRaw, criterioFact, criterioNoFact, billableRulesJson) {
        const hasPanelJson = jsonRaw != null && String(jsonRaw).trim() !== '';
        this.panelMetaCopy = parsePanelMetaFromJson(jsonRaw, { repair: hasPanelJson });
        if (billableRulesJson !== undefined && billableRulesJson !== null) {
            this.applyBillableRulesFromStored(billableRulesJson);
        } else if (criterioFact || criterioNoFact) {
            this.criterioCalculoFacturable = criterioFact || '';
            this.criterioCalculoNoFacturable = criterioNoFact || '';
        } else {
            this.applyBillableRulesFromStored('');
        }
    }

    syncCatalogAmsFromLegacyGlobals() {
        const rows = (this.ticketTabRows || []).map((r) => ({ ...r, filters: [...(r.filters || [])] }));
        const ams = rows.find((r) => r.id === 'ams');
        if (!ams) {
            return;
        }
        let changed = false;
        if (this.uiOcultarTabGestionAms === true && ams.hidden !== true) {
            ams.hidden = true;
            changed = true;
        }
        if ((ams.filters || []).length === 0) {
            const motivos = (this.motivosGestionAms || '').trim();
            const servicios = (this.serviciosAms || '').trim();
            const campo = (this.campoCaseMotivoAms || '').trim();
            if (campo && motivos) {
                ams.filters.push(createFilterRow(campo, motivos, false));
                changed = true;
            }
            if (servicios) {
                const servicioField =
                    (this.caseFieldOptions || []).find((o) => o.value === 'Servicio__c')?.value ||
                    'Servicio__c';
                ams.filters.push(createFilterRow(servicioField, servicios, false));
                changed = true;
            }
        }
        if (
            this.amsFiltroCreadoDiasAtras != null &&
            this.amsFiltroCreadoDiasAtras > 0 &&
            (ams.createdDateDaysBack == null || ams.createdDateDaysBack === '')
        ) {
            ams.createdDateDaysBack = this.amsFiltroCreadoDiasAtras;
            ams.supportsCreatedDateFilter = true;
            changed = true;
        }
        if (changed) {
            this.ticketTabRows = rows;
            this.syncTicketTabsFromRows();
        }
    }

    syncAmsGlobalFlagsFromCatalog() {
        const ams = (this.ticketTabRows || []).find((r) => r.id === 'ams');
        if (ams) {
            this.uiOcultarTabGestionAms = ams.hidden === true;
        }
    }

    handleValidateBillableRules() {
        this.syncBillableCriteriaFromRules();
        this.toast(
            'Reglas validadas',
            'Resumen de criterios actualizado. Revisa los textos de referencia y guarda para persistir.',
            'success'
        );
    }

    handleRestorePanelMetaDefaults() {
        this.panelMetaCopy = repairPanelMetaCopy({ ...DEFAULT_PANEL_META_COPY });
        this.markDirty();
        this.toast('Textos restaurados', 'Se aplicaron los textos e iconos por defecto (UTF-8). Guarda para persistir.', 'success');
    }

    handleAddBillableExtraFilter() {
        if ((this.billableExtraFilters || []).length >= 8) {
            return;
        }
        this.billableExtraFilters = [
            ...(this.billableExtraFilters || []),
            createBillableFilterRow('Case', '', '', 'excepcionFacturable')
        ];
        this.syncBillableCriteriaFromRules();
        this.markDirty();
    }

    handleRemoveBillableExtraFilter(event) {
        const fkey = event.currentTarget.dataset.fkey;
        this.billableExtraFilters = (this.billableExtraFilters || []).filter((f) => f._fkey !== fkey);
        this.syncBillableCriteriaFromRules();
        this.markDirty();
    }

    handleBillableExtraFilterChange(event) {
        const fkey = event.currentTarget.dataset.fkey;
        const field = event.currentTarget.dataset.field;
        let value =
            event.detail && event.detail.value !== undefined ? event.detail.value : event.target.value;
        if (field === 'values' && Array.isArray(value)) {
            value = joinValuesList(value);
        }
        const rows = (this.billableExtraFilters || []).map((f) => {
            if (f._fkey !== fkey) {
                return f;
            }
            const next = { ...f, [field]: value };
            if (field === 'objectApi') {
                next.fieldApi = '';
                next.values = '';
            }
            if (field === 'fieldApi') {
                next.values = '';
            }
            return next;
        });
        this.billableExtraFilters = rows;
        this.syncBillableCriteriaFromRules();
        this.markDirty();
    }

    applyColorDefaults() {
        Object.keys(COLOR_DEFAULTS).forEach((k) => {
            if (!this[k]) {
                this[k] = COLOR_DEFAULTS[k];
            }
        });
    }

    captureSnapshot() {
        this.savedSnapshot = JSON.stringify(this.buildPayload());
        // Reset memoización: ahora el estado guardado y el editable coinciden, no hay nada sucio.
        this._changeTick += 1;
        this._lastDirtyTick = this._changeTick;
        this._lastDirtyResult = false;
    }

    applySnapshot(snap) {
        this.recordId = snap.recordId || null;
        this.recordName = snap.recordName || 'DEFAULT';
        this.recordNameEditing = false;
        this.pepSiempreFacturables = snap.pepSiempreFacturables || '';
        this.pepFallback = snap.pepFallback || '';
        this.motivosGestionAms = snap.motivosGestionAms || '';
        this.motivosFallback = snap.motivosFallback || '';
        this.serviciosAms = snap.serviciosAms || '';
        this.serviciosFallback = snap.serviciosFallback || '';
        this.maxTicketsAnclados = snap.maxTicketsAnclados;
        this.diasFranjaCalendario = snap.diasFranjaCalendario;
        this.umbralHorasDia = snap.umbralHorasDia;
        this.umbralAvisoHorasDia = snap.umbralAvisoHorasDia;
        this.tamanoPaginaTickets = snap.tamanoPaginaTickets;
        this.metaFacturablePct = snap.metaFacturablePct;
        this.origenImputacionDefault = snap.origenImputacionDefault || snap.recordName || 'DEFAULT';
        this.horasMetaDiaLab = snap.horasMetaDiaLab;
        this.amsFiltroCreadoDiasAtras = snap.amsFiltroCreadoDiasAtras;
        this.limiteSoqlDesgloseDia = snap.limiteSoqlDesgloseDia;
        this.limiteSoqlMesAgregacion = snap.limiteSoqlMesAgregacion;
        this.limiteSoqlOwnerOpciones = snap.limiteSoqlOwnerOpciones;
        this.ayudaTextoGeneral = snap.ayudaTextoGeneral || '';
        this.uiMostrarGuiaUso = snap.uiMostrarGuiaUso !== false;
        this.guiaUsoTexto = snap.guiaUsoTexto || '';
        this.festivosExtraMmDd = snap.festivosExtraMmDd || '';
        this.imputacionMesesRetro = snap.imputacionMesesRetro;
        this.imputacionMesesAdelante = snap.imputacionMesesAdelante;
        this.serviciosUltimoRecurso = snap.serviciosUltimoRecurso || '';
        this.motivosUltimoRecurso = snap.motivosUltimoRecurso || '';
        this.uiOcultarImportarCsv = snap.uiOcultarImportarCsv === true;
        this.uiOcultarExportarCsv = snap.uiOcultarExportarCsv === true;
        this.uiOcultarPanelTrimestral = snap.uiOcultarPanelTrimestral === true;
        this.uiOcultarTabGestionAms = snap.uiOcultarTabGestionAms === true;
        this.campoCaseMotivoAms = snap.campoCaseMotivoAms || '';
        this.ayudaAdminMonitor = snap.ayudaAdminMonitor || '';
        this.colorCalDiaVacioFondo = snap.colorCalDiaVacioFondo || COLOR_DEFAULTS.colorCalDiaVacioFondo;
        this.colorCalDiaParcialFondo = snap.colorCalDiaParcialFondo || COLOR_DEFAULTS.colorCalDiaParcialFondo;
        this.colorCalDiaParcialBorde = snap.colorCalDiaParcialBorde || COLOR_DEFAULTS.colorCalDiaParcialBorde;
        this.colorCalDiaMetaFondo = snap.colorCalDiaMetaFondo || COLOR_DEFAULTS.colorCalDiaMetaFondo;
        this.colorCalDiaMetaBorde = snap.colorCalDiaMetaBorde || COLOR_DEFAULTS.colorCalDiaMetaBorde;
        this.colorCalDiaSobreUmbral = snap.colorCalDiaSobreUmbral || COLOR_DEFAULTS.colorCalDiaSobreUmbral;
        this.colorCalDiaFeriadoFondo = snap.colorCalDiaFeriadoFondo || COLOR_DEFAULTS.colorCalDiaFeriadoFondo;
        this.colorCalDiaFinSemanaFondo = snap.colorCalDiaFinSemanaFondo || COLOR_DEFAULTS.colorCalDiaFinSemanaFondo;
        this.colorCalDiaSeleccionFondo = snap.colorCalDiaSeleccionFondo || COLOR_DEFAULTS.colorCalDiaSeleccionFondo;
        this.colorCalDiaSeleccionBorde = snap.colorCalDiaSeleccionBorde || COLOR_DEFAULTS.colorCalDiaSeleccionBorde;
        this.colorCalDiaBloqueadoFondo = snap.colorCalDiaBloqueadoFondo || COLOR_DEFAULTS.colorCalDiaBloqueadoFondo;
        this.colorGraficoFacturable = snap.colorGraficoFacturable || COLOR_DEFAULTS.colorGraficoFacturable;
        this.colorGraficoNoFacturable = snap.colorGraficoNoFacturable || COLOR_DEFAULTS.colorGraficoNoFacturable;
        this.colorGraficoMetaProgreso = snap.colorGraficoMetaProgreso || COLOR_DEFAULTS.colorGraficoMetaProgreso;
        this.colorGraficoImputable = snap.colorGraficoImputable || COLOR_DEFAULTS.colorGraficoImputable;
        this.pestanasCatalogoTickets = snap.pestanasCatalogoTickets || '';
        this.permitirImputarFinSemana = snap.permitirImputarFinSemana !== false;
        this.permitirImputarFeriados = snap.permitirImputarFeriados !== false;
        this.textoAvisoFinSemana = snap.textoAvisoFinSemana || '';
        this.textoAvisoUmbralHoras = snap.textoAvisoUmbralHoras || '';
        this.textoAvisoFeriado = snap.textoAvisoFeriado || '';
        this.textoConfirmacionImputacion = snap.textoConfirmacionImputacion || '';
        this.textoSubtituloCentro =
            snap.textoSubtituloCentro != null ? snap.textoSubtituloCentro : '';
        this.excepcionFinSemanaUserCampo = snap.excepcionFinSemanaUserCampo || '';
        this.excepcionFinSemanaUserValores = snap.excepcionFinSemanaUserValores || '';
        this.activarAvisoUmbralHoras = snap.activarAvisoUmbralHoras !== false;
        this.filtroServicioTickets = snap.filtroServicioTickets || '';
        this.filtroConsultorUserCampo = snap.filtroConsultorUserCampo || '';
        this.filtroConsultorUserValores = snap.filtroConsultorUserValores || '';
        this.applyPanelMetaFromStored(
            snap.panelMetaCopyJson,
            snap.criterioCalculoFacturable,
            snap.criterioCalculoNoFacturable,
            snap.criteriosFacturableFiltrosJson != null ? snap.criteriosFacturableFiltrosJson : ''
        );
        this.origenImputacionEditing = false;
        this.loadTicketTabsFromStorage();
    }

    applyDataFromServer(d) {
        this.recordId = d.recordId || null;
        this.recordName = d.recordName || 'DEFAULT';
        this.recordNameEditing = false;
        this.origenImputacionEditing = false;
        this.pepSiempreFacturables = d.pepSiempreFacturables || '';
        this.pepFallback = d.pepFallback || '';
        this.motivosGestionAms = d.motivosGestionAms || '';
        this.motivosFallback = d.motivosFallback || '';
        this.serviciosAms = d.serviciosAms || '';
        this.serviciosFallback = d.serviciosFallback || '';
        if (d.maxTicketsAnclados != null) {
            this.maxTicketsAnclados = d.maxTicketsAnclados;
        }
        if (d.diasFranjaCalendario != null) {
            this.diasFranjaCalendario = d.diasFranjaCalendario;
        }
        if (d.umbralHorasDia != null) {
            this.umbralHorasDia = d.umbralHorasDia;
        }
        if (d.umbralAvisoHorasDia != null) {
            this.umbralAvisoHorasDia = d.umbralAvisoHorasDia;
        } else {
            this.umbralAvisoHorasDia = 10;
        }
        if (d.tamanoPaginaTickets != null) {
            this.tamanoPaginaTickets = d.tamanoPaginaTickets;
        } else {
            this.tamanoPaginaTickets = 200;
        }
        this.metaFacturablePct = d.metaFacturablePct != null ? d.metaFacturablePct : null;
        this.origenImputacionDefault =
            d.origenImputacionDefault != null && d.origenImputacionDefault !== ''
                ? d.origenImputacionDefault
                : this.recordName;
        this.permitirImputarFinSemana = d.permitirImputarFinSemana !== false;
        this.permitirImputarFeriados = d.permitirImputarFeriados !== false;
        this.textoAvisoFinSemana = d.textoAvisoFinSemana || '';
        this.textoAvisoUmbralHoras = d.textoAvisoUmbralHoras || '';
        this.textoAvisoFeriado = d.textoAvisoFeriado || '';
        this.textoConfirmacionImputacion = d.textoConfirmacionImputacion || '';
        this.textoSubtituloCentro = d.textoSubtituloCentro != null ? d.textoSubtituloCentro : '';
        this.excepcionFinSemanaUserCampo = d.excepcionFinSemanaUserCampo || '';
        this.excepcionFinSemanaUserValores = d.excepcionFinSemanaUserValores || '';
        this.activarAvisoUmbralHoras = d.activarAvisoUmbralHoras !== false;
        this.filtroServicioTickets = d.filtroServicioTickets || '';
        this.filtroConsultorUserCampo = d.filtroConsultorUserCampo || '';
        this.filtroConsultorUserValores = d.filtroConsultorUserValores || '';
        if (d.recordId) {
            this.applyPanelMetaFromStored(
                d.panelMetaCopyJson,
                d.criterioCalculoFacturable,
                d.criterioCalculoNoFacturable,
                d.criteriosFacturableFiltrosJson != null ? d.criteriosFacturableFiltrosJson : ''
            );
        } else {
            this.applyPanelMetaDefaults();
        }
        this.pestanasCatalogoTickets = d.pestanasCatalogoTickets || '';
        this.loadTicketTabsFromStorage();
        if (d.recordId) {
            this.syncAmsGlobalFlagsFromCatalog();
        }
        this.horasMetaDiaLab = d.horasMetaDiaLab != null ? d.horasMetaDiaLab : null;
        this.amsFiltroCreadoDiasAtras =
            d.amsFiltroCreadoDiasAtras != null ? d.amsFiltroCreadoDiasAtras : null;
        this.limiteSoqlDesgloseDia = d.limiteSoqlDesgloseDia != null ? d.limiteSoqlDesgloseDia : null;
        this.limiteSoqlMesAgregacion =
            d.limiteSoqlMesAgregacion != null ? d.limiteSoqlMesAgregacion : null;
        this.limiteSoqlOwnerOpciones =
            d.limiteSoqlOwnerOpciones != null ? d.limiteSoqlOwnerOpciones : null;
        this.ayudaTextoGeneral = d.ayudaTextoGeneral || '';
        this.uiMostrarGuiaUso = d.uiMostrarGuiaUso !== false;
        this.guiaUsoTexto = d.guiaUsoTexto || '';
        this.festivosExtraMmDd = d.festivosExtraMmDd || '';
        this.imputacionMesesRetro = d.imputacionMesesRetro != null ? d.imputacionMesesRetro : null;
        this.imputacionMesesAdelante =
            d.imputacionMesesAdelante != null ? d.imputacionMesesAdelante : null;
        this.serviciosUltimoRecurso = d.serviciosUltimoRecurso || '';
        this.motivosUltimoRecurso = d.motivosUltimoRecurso || '';
        this.uiOcultarImportarCsv = d.uiOcultarImportarCsv === true;
        this.uiOcultarExportarCsv = d.uiOcultarExportarCsv === true;
        this.uiOcultarPanelTrimestral = d.uiOcultarPanelTrimestral === true;
        this.uiOcultarTabGestionAms = d.uiOcultarTabGestionAms === true;
        this.campoCaseMotivoAms = d.campoCaseMotivoAms || '';
        this.ayudaAdminMonitor = d.ayudaAdminMonitor || '';
        this.applyColorFieldFromServer('colorCalDiaVacioFondo', d.colorCalDiaVacioFondo);
        this.applyColorFieldFromServer('colorCalDiaParcialFondo', d.colorCalDiaParcialFondo);
        this.applyColorFieldFromServer('colorCalDiaParcialBorde', d.colorCalDiaParcialBorde);
        this.applyColorFieldFromServer('colorCalDiaMetaFondo', d.colorCalDiaMetaFondo);
        this.applyColorFieldFromServer('colorCalDiaMetaBorde', d.colorCalDiaMetaBorde);
        this.applyColorFieldFromServer('colorCalDiaSobreUmbral', d.colorCalDiaSobreUmbral);
        this.applyColorFieldFromServer('colorCalDiaFeriadoFondo', d.colorCalDiaFeriadoFondo);
        this.applyColorFieldFromServer('colorCalDiaFinSemanaFondo', d.colorCalDiaFinSemanaFondo);
        this.applyColorFieldFromServer('colorCalDiaSeleccionFondo', d.colorCalDiaSeleccionFondo);
        this.applyColorFieldFromServer('colorCalDiaSeleccionBorde', d.colorCalDiaSeleccionBorde);
        this.applyColorFieldFromServer('colorCalDiaBloqueadoFondo', d.colorCalDiaBloqueadoFondo);
        this.applyColorFieldFromServer('colorGraficoFacturable', d.colorGraficoFacturable);
        this.applyColorFieldFromServer('colorGraficoNoFacturable', d.colorGraficoNoFacturable);
        this.applyColorFieldFromServer('colorGraficoMetaProgreso', d.colorGraficoMetaProgreso);
        this.applyColorFieldFromServer('colorGraficoImputable', d.colorGraficoImputable);
        try {
            const diag = JSON.parse(d.diagnosticsJson || '[]');
            this.applyDiagnosticRows(Array.isArray(diag) ? diag : []);
        } catch (e) {
            this.applyDiagnosticRows([]);
        }
        if (!d.recordId) {
            this.applyColorDefaults();
        }
    }

    applyColorFieldFromServer(fieldKey, serverValue) {
        if (serverValue != null && String(serverValue).trim() !== '') {
            this[fieldKey] = serverValue;
        } else if (this.recordId) {
            this[fieldKey] = '';
        }
    }

    applyDiagnosticRows(rawRows) {
        const classified = (rawRows || []).map((r) => ({
            ...r,
            rowKind: r.rowKind || inferDiagnosticRowKind(r.source)
        }));
        const code = classified.filter((r) => r.rowKind === 'code');
        const runtime = classified.filter((r) => r.rowKind === 'runtime');
        const config = classified.filter((r) => r.rowKind === 'config');
        this._diagnosticCodeRows = code;
        this._diagnosticRuntimeRows = runtime;
        this._diagnosticConfigRows = config;
        this.diagnosticRows = [...code, ...runtime, ...config];
    }

    async refresh() {
        this.loaded = false;
        try {
            const raw = await loadCentroConfig();
            const d = JSON.parse(raw || '{}');
            this.canEdit = d.success === true;
            this.leadMessage = d.message || '';
            if (d.success) {
                this.applyDataFromServer(d);
                this.captureSnapshot();
            } else {
                this.savedSnapshot = null;
                this.toast('Sin acceso', this.leadMessage || 'No puedes usar esta pantalla.', 'warning');
            }
        } catch (e) {
            const msg = e.body && e.body.message ? e.body.message : e.message;
            this.toast('Error', msg || String(e), 'error');
        } finally {
            this.loaded = true;
        }
    }

    handleMapZoneClick(event) {
        this.selectSection(event.currentTarget.dataset.section);
    }

    selectSection(id) {
        if (!id) {
            return;
        }
        this.activeNavId = id;
        requestAnimationFrame(() => {
            const body = this.template.querySelector('.cc-section-host');
            if (body) {
                body.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    openDiagnosticsModal() {
        this.diagnosticsModalOpen = true;
    }

    closeDiagnosticsModal() {
        this.diagnosticsModalOpen = false;
    }

    handleDiagnosticsBackdropClick(event) {
        if (event.target.dataset.modalBackdrop === 'true') {
            this.closeDiagnosticsModal();
        }
    }

    toggleRecordNameEdit() {
        this.recordNameEditing = !this.recordNameEditing;
        if (!this.recordNameEditing && !this.origenImputacionEditing) {
            this.origenImputacionDefault = this.recordName;
        }
    }

    toggleOrigenImputacionEdit() {
        this.origenImputacionEditing = !this.origenImputacionEditing;
        if (!this.origenImputacionEditing) {
            this.origenImputacionDefault = this.recordName;
        }
    }

    handleDiscard() {
        if (!this.isDirty || !this.savedSnapshot) {
            return;
        }
        try {
            this.applySnapshot(JSON.parse(this.savedSnapshot));
            // Tras restaurar el snapshot, el estado vuelve a coincidir; invalidamos cache y forzamos "limpio".
            this._changeTick += 1;
            this._lastDirtyTick = this._changeTick;
            this._lastDirtyResult = false;
            this.toast('Descartado', 'Se restauraron los valores del ultimo estado guardado o cargado.', 'info');
        } catch (e) {
            this.toast('Error', 'No se pudieron descartar los cambios.', 'error');
        }
    }

    handleNativeInputChange(e) {
        const f = e.target.dataset.field;
        if (f && COLOR_FIELD_KEYS.has(f)) {
            let hex = (e.target.value || '').trim();
            if (hex && !hex.startsWith('#')) {
                hex = '#' + hex;
            }
            this[f] = hex ? hex.toUpperCase() : hex;
            this.markDirty();
            return;
        }
        this.handleChange(e);
    }

    handleChange(e) {
        this.markDirty();
        const f = e.target.dataset.field;
        let v = e.detail && e.detail.value !== undefined ? e.detail.value : e.target.value;
        if (f === 'recordName') {
            this.recordName = v;
            if (!this.origenImputacionEditing) {
                this.origenImputacionDefault = v;
            }
        } else if (f === 'pep') {
            this.pepSiempreFacturables = v;
        } else if (f === 'pepFb') {
            this.pepFallback = v;
        } else if (f === 'motivos') {
            this.motivosGestionAms = v;
        } else if (f === 'motivosFb') {
            this.motivosFallback = v;
        } else if (f === 'servicios') {
            this.serviciosAms = v;
        } else if (f === 'serviciosFb') {
            this.serviciosFallback = v;
        } else if (f === 'maxPin') {
            this.maxTicketsAnclados = v === '' || v == null ? null : Number(v);
        } else if (f === 'diasFranja') {
            const n = v === '' || v == null ? null : Number(v);
            if (n != null && Number.isFinite(n)) {
                this.diasFranjaCalendario = Math.max(1, Math.min(21, Math.floor(n)));
            } else {
                this.diasFranjaCalendario = null;
            }
        } else if (f === 'umbral') {
            this.umbralHorasDia = v === '' || v == null ? null : Number(v);
        } else if (f === 'umbralAviso') {
            this.umbralAvisoHorasDia = v === '' || v == null ? null : Number(v);
        } else if (f === 'tamPag') {
            this.tamanoPaginaTickets = v === '' || v == null ? null : Number(v);
        } else if (f === 'metaPct') {
            this.metaFacturablePct = v === '' || v == null ? null : Number(v);
        } else if (f === 'origenDef') {
            this.origenImputacionDefault = v;
        } else if (f === 'horasMetaLab') {
            this.horasMetaDiaLab = v === '' || v == null ? null : Number(v);
        } else if (f === 'amsFiltroDias') {
            this.amsFiltroCreadoDiasAtras = v === '' || v == null ? null : Number(v);
        } else if (f === 'limSoqlDia') {
            this.limiteSoqlDesgloseDia = v === '' || v == null ? null : Number(v);
        } else if (f === 'limSoqlMes') {
            this.limiteSoqlMesAgregacion = v === '' || v == null ? null : Number(v);
        } else if (f === 'limSoqlOwner') {
            this.limiteSoqlOwnerOpciones = v === '' || v == null ? null : Number(v);
        } else if (f === 'ayudaGen') {
            this.ayudaTextoGeneral = v;
        } else if (f === 'guiaUsoTxt') {
            this.guiaUsoTexto = v;
        } else if (f === 'uiGuiaUso') {
            this.uiMostrarGuiaUso = !!e.detail.checked;
        } else if (f === 'festivosExtra') {
            this.festivosExtraMmDd = v;
        } else if (f === 'mesRetro') {
            this.imputacionMesesRetro = v === '' || v == null ? null : Number(v);
        } else if (f === 'mesAdelante') {
            this.imputacionMesesAdelante = v === '' || v == null ? null : Number(v);
        } else if (f === 'servUr') {
            this.serviciosUltimoRecurso = v;
        } else if (f === 'motivUr') {
            this.motivosUltimoRecurso = v;
        } else if (f === 'uiHideCsv') {
            this.uiOcultarImportarCsv = !!e.detail.checked;
        } else if (f === 'uiHideQuarter') {
            this.uiOcultarPanelTrimestral = !!e.detail.checked;
        } else if (f === 'uiHideAmsTab') {
            this.uiOcultarTabGestionAms = !!e.detail.checked;
        } else if (f === 'campoCaseAms') {
            this.campoCaseMotivoAms = v;
        } else if (f === 'ayudaAdminMon') {
            this.ayudaAdminMonitor = v;
        } else if (f === 'pestanasCat') {
            this.pestanasCatalogoTickets = v;
            this.loadTicketTabsFromStorage();
        } else if (f === 'permitirFinSem') {
            this.permitirImputarFinSemana = !!e.detail.checked;
        } else if (f === 'permitirFeriado') {
            this.permitirImputarFeriados = !!e.detail.checked;
        } else if (f === 'textoFinSem') {
            this.textoAvisoFinSemana = v;
        } else if (f === 'textoUmbralHoras') {
            this.textoAvisoUmbralHoras = v;
        } else if (f === 'textoFeriado') {
            this.textoAvisoFeriado = v;
        } else if (f === 'textoConfirm') {
            this.textoConfirmacionImputacion = v;
        } else if (f === 'textoSubtitulo') {
            this.textoSubtituloCentro = v;
        } else if (f === 'excFinSemUserCampo') {
            this.excepcionFinSemanaUserCampo = v;
        } else if (f === 'excFinSemUserVals') {
            this.excepcionFinSemanaUserValores = v;
        } else if (f === 'activarAvisoUmbral') {
            this.activarAvisoUmbralHoras = !!e.detail.checked;
        } else if (f === 'filtroServicioTkt') {
            this.filtroServicioTickets = v;
        } else if (f === 'filtroConsUserCampo') {
            this.filtroConsultorUserCampo = v;
        } else if (f === 'filtroConsUserVals') {
            this.filtroConsultorUserValores = v;
        } else if (f === 'billableCaseField') {
            this.billableCaseFieldApi = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableCaseVals') {
            this.billableCaseValues = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableIndField') {
            this.billableImputacionIndField = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableFaVals') {
            this.billableImputacionFaValues = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableNfVals') {
            this.billableImputacionNfValues = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableCaseExcField') {
            this.billableCaseExcFieldApi = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableCaseExcVals') {
            this.billableCaseExcValues = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableImpExcField') {
            this.billableImputacionExcFieldApi = v;
            this.syncBillableCriteriaFromRules();
        } else if (f === 'billableImpExcVals') {
            this.billableImputacionExcValues = v;
            this.syncBillableCriteriaFromRules();
        } else if (PANEL_META_FIELD_DEFS.some((d) => d.key === f)) {
            const def = PANEL_META_FIELD_DEFS.find((d) => d.key === f);
            const nextVal = def && def.kind === 'icon' ? normalizeSldsIconValue(v) : v;
            this.panelMetaCopy = { ...this.panelMetaCopy, [f]: nextVal };
        }
    }

    async handleSave() {
        if (this.isSaving) {
            return;
        }
        this.ticketTabRows = normalizeTicketTabRows(this.ticketTabRows);
        this.syncTicketTabsFromRows();
        const tabsErr = validateTabsRows(this.ticketTabRows);
        if (tabsErr) {
            this.toast('Pestanas invalidas', tabsErr, 'error');
            this.selectSection('ticketTable');
            return;
        }
        this.isSaving = true;
        const payload = this.buildPayload();
        try {
            const raw = await saveCentroConfig({ payloadJson: JSON.stringify(payload) });
            const d = JSON.parse(raw || '{}');
            if (d.success) {
                this.recordId = d.recordId || this.recordId;
                this.toast('Listo', d.message || 'Guardado.', 'success');
                await this.refresh();
            } else {
                this.toast('No se guardo', d.message || 'Error', 'error');
            }
        } catch (e) {
            const msg = e.body && e.body.message ? e.body.message : e.message;
            this.toast('Error', msg || String(e), 'error');
        } finally {
            this.isSaving = false;
        }
    }
}

function normalizeHexColor(raw) {
    if (raw == null || raw === '') {
        return raw;
    }
    let t = String(raw).trim();
    if (!t) {
        return t;
    }
    if (!t.startsWith('#')) {
        t = '#' + t;
    }
    return t.toUpperCase();
}

