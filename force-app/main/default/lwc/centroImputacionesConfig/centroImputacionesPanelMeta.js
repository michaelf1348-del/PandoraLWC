/** Textos e iconos del panel derecho (meta facturable). UTF-8. */

export const BADGE_ICON_OPTIONS = [
    { label: 'Objetivo (target)', value: 'utility:target' },
    { label: 'Naturaleza / tractor', value: 'utility:animal_and_nature' },
    { label: 'Subir / avion', value: 'utility:up' },
    { label: 'Exito', value: 'utility:success' },
    { label: 'Favorito / logrado', value: 'utility:favorite' },
    { label: 'Estrella', value: 'utility:favorite_alt' },
    { label: 'Advertencia', value: 'utility:warning' },
    { label: 'Info', value: 'utility:info' }
];

const ICON_LABEL_BY_VALUE = Object.fromEntries(BADGE_ICON_OPTIONS.map((o) => [o.value, o.label]));

export const DEFAULT_PANEL_META_COPY = {
    msg0: '"Que comiencen los juegos del hambre" ??. Reci�n calentando motores para el mes.',
    msg40: 'Agarrando vuelo. "No es mucho, pero es trabajo honesto" ????? Vamos bien.',
    msg70: '"�Al infinito y m�s all�!" ?? Vamos como avi�n despachando los tickets de SAP.',
    msg85: 'El �ltimo esfuerzo. �Cuenta regresiva para el bono facturable! ??',
    msg100: '�Misi�n cumplida! "�Esto es Esparta!" ??? Meta conquistada con honores.',
    badge0: 'Juegos del Hambre ??',
    badge40: 'Trabajo honesto ??',
    badge70: 'Al infinito ??',
    badge85: '�Corre Forrest! ?????',
    badge100: 'Lo Lograste ???',
    badgeIcon0: 'utility:target',
    badgeIcon40: 'utility:animal_and_nature',
    badgeIcon70: 'utility:up',
    badgeIcon85: 'utility:success',
    badgeIcon100: 'utility:favorite'
};

// Defaults UTF-8 (emojis as escapes). Used only when field empty or corrupt on load.
const _PANEL_META_DEFAULTS_UTF8 = {
    msg0: '"Que comiencen los juegos del hambre" \uD83C\uDFF9. Reci\u00e9n calentando motores para el mes.',
    msg40: 'Agarrando vuelo. "No es mucho, pero es trabajo honesto" \uD83D\uDC68\u200D\uD83C\uDF3E. Vamos bien.',
    msg70: '"\u00a1Al infinito y m\u00e1s all\u00e1!" \uD83D\uDE80. Vamos como avi\u00f3n despachando los tickets de SAP.',
    msg85: 'El \u00faltimo esfuerzo. \u00a1Cuenta regresiva para el bono facturable! \uD83C\uDFAF',
    msg100: '\u00a1Misi\u00f3n cumplida! "\u00a1Esto es Esparta!" \uD83D\uDEE1\uFE0F. Meta conquistada con honores.',
    badge0: 'Juegos del Hambre \uD83C\uDFF9',
    badge40: 'Trabajo honesto \uD83D\uDC68\u200D\uD83C\uDF3E',
    badge70: 'Al infinito \uD83D\uDE80',
    badge85: '\u00a1Corre Forrest! \uD83C\uDFC3',
    badge100: 'Lo Lograste \uD83C\uDFC6'
};
Object.assign(DEFAULT_PANEL_META_COPY, _PANEL_META_DEFAULTS_UTF8);

export const PANEL_META_FIELD_DEFS = [
    { key: 'msg0', label: 'Mensaje (0-39 % meta)', kind: 'text' },
    { key: 'msg40', label: 'Mensaje (40-69 %)', kind: 'text' },
    { key: 'msg70', label: 'Mensaje (70-84 %)', kind: 'text' },
    { key: 'msg85', label: 'Mensaje (85-99 %)', kind: 'text' },
    { key: 'msg100', label: 'Mensaje (100 %+)', kind: 'text' },
    { key: 'badge0', label: 'Badge corto (0-39 %)', kind: 'text' },
    { key: 'badge40', label: 'Badge corto (40-69 %)', kind: 'text' },
    { key: 'badge70', label: 'Badge corto (70-84 %)', kind: 'text' },
    { key: 'badge85', label: 'Badge corto (85-99 %)', kind: 'text' },
    { key: 'badge100', label: 'Badge corto (100 %+)', kind: 'text' },
    { key: 'badgeIcon0', label: 'Icono SLDS (0-39 %)', kind: 'icon' },
    { key: 'badgeIcon40', label: 'Icono SLDS (40-69 %)', kind: 'icon' },
    { key: 'badgeIcon70', label: 'Icono SLDS (70-84 %)', kind: 'icon' },
    { key: 'badgeIcon85', label: 'Icono SLDS (85-99 %)', kind: 'icon' },
    { key: 'badgeIcon100', label: 'Icono SLDS (100 %+)', kind: 'icon' }
];

export const DEFAULT_CRITERIO_FACTURABLE =
    'Horas del mes con Ind_Imputacion__c = FA (o sin marca NF). En la seleccion pendiente: sin "No fact." y sin ticket de gestion AMS.';

export const DEFAULT_CRITERIO_NO_FACTURABLE =
    'Horas con Ind_Imputacion__c = NF, tickets AMS gestion, o checkbox No fact. activo en la fila.';

export const BILLABLE_OBJECT_OPTIONS = [
    { label: 'Case', value: 'Case' },
    { label: 'Imputacion__c', value: 'Imputacion__c' }
];

export const BILLABLE_EFFECT_OPTIONS = [
    { label: 'Excepcion: siempre facturable', value: 'excepcionFacturable' },
    { label: 'Marca no facturable', value: 'noFacturable' },
    { label: 'Marca facturable', value: 'facturable' }
];

export const DEFAULT_BILLABLE_RULES = {
    caseNoFacturable: { fieldApi: 'Reason', values: '' },
    caseExcepcionFacturable: { fieldApi: '', values: '' },
    imputacionIndField: 'Ind_Imputacion__c',
    imputacionFacturableValues: 'FA',
    imputacionNoFacturableValues: 'NF',
    imputacionExcepcionFacturable: { fieldApi: '', values: '' },
    extraFilters: []
};

let _billableFilterKeySeq = 0;

function nextBillableFilterKey() {
    _billableFilterKeySeq += 1;
    return `bf-${_billableFilterKeySeq}`;
}

export function createBillableFilterRow(
    objectApi = 'Case',
    fieldApi = '',
    values = '',
    effect = 'excepcionFacturable'
) {
    return {
        _fkey: nextBillableFilterKey(),
        objectApi: objectApi || 'Case',
        fieldApi: fieldApi || '',
        values: values || '',
        effect: effect || 'excepcionFacturable'
    };
}

/** Convierte etiqueta del combobox o valor suelto al API SLDS utility:xxx */
export function normalizeSldsIconValue(raw) {
    const s = String(raw || '').trim();
    if (!s) {
        return 'utility:target';
    }
    if (/^(utility|standard|action|custom):/.test(s)) {
        return s;
    }
    const byLabel = BADGE_ICON_OPTIONS.find((o) => o.label === s);
    if (byLabel) {
        return byLabel.value;
    }
    const byValue = BADGE_ICON_OPTIONS.find((o) => o.value === s);
    if (byValue) {
        return byValue.value;
    }
    const lower = s.toLowerCase();
    if (lower.includes('target') || lower.includes('objetivo')) {
        return 'utility:target';
    }
    if (lower.includes('tractor') || lower.includes('naturaleza')) {
        return 'utility:animal_and_nature';
    }
    if (lower.includes('avion') || lower.includes('subir')) {
        return 'utility:up';
    }
    if (lower.includes('exito') || lower.includes('success')) {
        return 'utility:success';
    }
    if (lower.includes('favorito') || lower.includes('favorite')) {
        return 'utility:favorite';
    }
    return 'utility:target';
}

function panelMetaTextLooksCorrupt(val) {
    if (val == null) {
        return false;
    }
    const s = String(val);
    if (!s.trim()) {
        return false;
    }
    return (
        s.includes('\uFFFD') ||
        /\?\?/.test(s) ||
        /\bRecin\b/i.test(s) ||
        /\bReci[^a-z\u00e9]n\b/i.test(s) ||
        /\bms all\b/i.test(s) ||
        /\bltimo\b/i.test(s) ||
        /\bMisin\b/i.test(s) ||
        /\bMisi[^a-z\u00f3]n\b/i.test(s) ||
        /\bavi[^a-z\u00f3]n\b/i.test(s)
    );
}

/** Repara textos con encoding roto; normaliza iconos. */
export function repairPanelMetaCopy(copy) {
    const out = { ..._PANEL_META_DEFAULTS_UTF8, ...(copy || {}) };
    PANEL_META_FIELD_DEFS.forEach((d) => {
        if (d.kind === 'icon') {
            out[d.key] = normalizeSldsIconValue(out[d.key]);
        } else if (panelMetaTextLooksCorrupt(out[d.key])) {
            out[d.key] = _PANEL_META_DEFAULTS_UTF8[d.key] || DEFAULT_PANEL_META_COPY[d.key];
        }
    });
    return out;
}

export function emptyPanelMetaCopy() {
    const out = {};
    PANEL_META_FIELD_DEFS.forEach((d) => {
        out[d.key] = '';
    });
    return out;
}

export function parsePanelMetaFromJson(raw, options = {}) {
    const repair = options.repair !== false;
    const base = repair ? { ...DEFAULT_PANEL_META_COPY } : emptyPanelMetaCopy();
    if (!raw || !String(raw).trim()) {
        return repair ? repairPanelMetaCopy(base) : emptyPanelMetaCopy();
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            PANEL_META_FIELD_DEFS.forEach((d) => {
                if (parsed[d.key] != null) {
                    base[d.key] = String(parsed[d.key]);
                }
            });
        }
    } catch (e) {
        /* defaults */
    }
    return repair ? repairPanelMetaCopy(base) : base;
}

export function serializePanelMetaToJson(copy) {
    const source = copy || {};
    const out = {};
    PANEL_META_FIELD_DEFS.forEach((d) => {
        const val = source[d.key];
        if (val != null && String(val).trim() !== '') {
            out[d.key] = d.kind === 'icon' ? normalizeSldsIconValue(val) : String(val);
        }
    });
    return JSON.stringify(out, null, 2);
}

const EMPTY_BILLABLE_RULES = {
    caseNoFacturable: { fieldApi: '', values: '' },
    caseExcepcionFacturable: { fieldApi: '', values: '' },
    imputacionIndField: '',
    imputacionFacturableValues: '',
    imputacionNoFacturableValues: '',
    imputacionExcepcionFacturable: { fieldApi: '', values: '' },
    extraFilters: []
};

export function parseBillableRulesFromJson(raw) {
    const base = {
        caseNoFacturable: { ...EMPTY_BILLABLE_RULES.caseNoFacturable },
        caseExcepcionFacturable: { ...EMPTY_BILLABLE_RULES.caseExcepcionFacturable },
        imputacionIndField: EMPTY_BILLABLE_RULES.imputacionIndField,
        imputacionFacturableValues: EMPTY_BILLABLE_RULES.imputacionFacturableValues,
        imputacionNoFacturableValues: EMPTY_BILLABLE_RULES.imputacionNoFacturableValues,
        imputacionExcepcionFacturable: { ...EMPTY_BILLABLE_RULES.imputacionExcepcionFacturable },
        extraFilters: []
    };
    if (!raw || !String(raw).trim()) {
        return base;
    }
    try {
        const p = JSON.parse(raw);
        if (p.caseNoFacturable) {
            base.caseNoFacturable = {
                fieldApi: String(p.caseNoFacturable.fieldApi || '').trim(),
                values: String(p.caseNoFacturable.values || '').trim()
            };
        }
        if (p.caseExcepcionFacturable) {
            base.caseExcepcionFacturable = {
                fieldApi: String(p.caseExcepcionFacturable.fieldApi || '').trim(),
                values: String(p.caseExcepcionFacturable.values || '').trim()
            };
        }
        if (p.imputacionExcepcionFacturable) {
            base.imputacionExcepcionFacturable = {
                fieldApi: String(p.imputacionExcepcionFacturable.fieldApi || '').trim(),
                values: String(p.imputacionExcepcionFacturable.values || '').trim()
            };
        }
        if (p.imputacionIndField) {
            base.imputacionIndField = String(p.imputacionIndField).trim();
        }
        if (p.imputacionFacturableValues) {
            base.imputacionFacturableValues = String(p.imputacionFacturableValues).trim();
        }
        if (p.imputacionNoFacturableValues) {
            base.imputacionNoFacturableValues = String(p.imputacionNoFacturableValues).trim();
        }
        if (Array.isArray(p.extraFilters)) {
            base.extraFilters = p.extraFilters
                .slice(0, 8)
                .map((f) =>
                    createBillableFilterRow(
                        f.objectApi,
                        f.fieldApi,
                        f.values,
                        f.effect
                    )
                );
        }
    } catch (e) {
        /* defaults */
    }
    return base;
}

export function serializeBillableRulesToJson(rules) {
    const r = rules || EMPTY_BILLABLE_RULES;
    const emptyCase = { fieldApi: '', values: '' };
    return JSON.stringify(
        {
            caseNoFacturable: r.caseNoFacturable || emptyCase,
            caseExcepcionFacturable: r.caseExcepcionFacturable || emptyCase,
            imputacionIndField: r.imputacionIndField != null ? r.imputacionIndField : '',
            imputacionFacturableValues:
                r.imputacionFacturableValues != null ? r.imputacionFacturableValues : '',
            imputacionNoFacturableValues:
                r.imputacionNoFacturableValues != null ? r.imputacionNoFacturableValues : '',
            imputacionExcepcionFacturable: r.imputacionExcepcionFacturable || emptyCase,
            extraFilters: (r.extraFilters || []).map((f) => ({
                objectApi: f.objectApi,
                fieldApi: f.fieldApi,
                values: f.values,
                effect: f.effect
            }))
        },
        null,
        2
    );
}

function effectLabel(effect) {
    const o = BILLABLE_EFFECT_OPTIONS.find((e) => e.value === effect);
    return o ? o.label : effect;
}

export function buildCriteriaSummaryFromRules(rules) {
    const r = rules || DEFAULT_BILLABLE_RULES;
    const casePart = r.caseNoFacturable?.fieldApi
        ? `Case.${r.caseNoFacturable.fieldApi} en [${r.caseNoFacturable.values || '(sin filtro Case)'}] ? no facturable en tabla.`
        : 'Tickets AMS (motivos del catálogo) → no facturable en tabla.';
    const caseExc =
        r.caseExcepcionFacturable?.fieldApi && r.caseExcepcionFacturable?.values
            ? ` Excepcion Case: ${r.caseExcepcionFacturable.fieldApi} en [${r.caseExcepcionFacturable.values}] ? siempre facturable.`
            : '';
    const ind = r.imputacionIndField || 'Ind_Imputacion__c';
    const impExc =
        r.imputacionExcepcionFacturable?.fieldApi && r.imputacionExcepcionFacturable?.values
            ? ` Excepcion Imputacion: ${r.imputacionExcepcionFacturable.fieldApi} en [${r.imputacionExcepcionFacturable.values}] ? facturable.`
            : '';
    let extra = '';
    (r.extraFilters || []).forEach((f, i) => {
        if (!f.fieldApi) {
            return;
        }
        extra += ` Regla ${i + 1}: ${f.objectApi}.${f.fieldApi} [${f.values}] ? ${effectLabel(f.effect)}.`;
    });
    return {
        facturable: `Tras guardar, el gráfico y la meta usan ${ind} (FA). Referencia de valores FA en config: [${r.imputacionFacturableValues || '(vacío)'}].${caseExc}${impExc}${extra}`,
        noFacturable: `Tras guardar, ${ind} (NF) en Salesforce. ${casePart} Referencia NF: [${r.imputacionNoFacturableValues || '(vacío)'}].${extra}`
    };
}

export function iconOptionLabel(iconValue) {
    return ICON_LABEL_BY_VALUE[normalizeSldsIconValue(iconValue)] || normalizeSldsIconValue(iconValue);
}
