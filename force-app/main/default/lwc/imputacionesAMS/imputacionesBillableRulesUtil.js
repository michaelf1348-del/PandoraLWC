/** Evaluacion facturable alineada con ImputacionesBillableRules (Apex) e Ind_Imputacion__c. */

const EMPTY_RULES = {
    caseNoFacturable: { fieldApi: '', values: '' },
    caseExcepcionFacturable: { fieldApi: '', values: '' },
    imputacionIndField: '',
    imputacionFacturableValues: '',
    imputacionNoFacturableValues: '',
    imputacionExcepcionFacturable: { fieldApi: '', values: '' },
    extraFilters: []
};

export function parseBillableRulesFromSettings(settings) {
    const raw = settings && settings.billableCriteriaFiltersJson;
    if (!raw || !String(raw).trim()) {
        return { ...EMPTY_RULES, extraFilters: [] };
    }
    try {
        const p = JSON.parse(raw);
        return {
            caseNoFacturable: {
                fieldApi: String((p.caseNoFacturable && p.caseNoFacturable.fieldApi) || '').trim(),
                values: String((p.caseNoFacturable && p.caseNoFacturable.values) || '').trim()
            },
            caseExcepcionFacturable: {
                fieldApi: String((p.caseExcepcionFacturable && p.caseExcepcionFacturable.fieldApi) || '').trim(),
                values: String((p.caseExcepcionFacturable && p.caseExcepcionFacturable.values) || '').trim()
            },
            imputacionIndField: String(p.imputacionIndField || '').trim(),
            imputacionFacturableValues: String(p.imputacionFacturableValues || '').trim(),
            imputacionNoFacturableValues: String(p.imputacionNoFacturableValues || '').trim(),
            imputacionExcepcionFacturable: {
                fieldApi: String((p.imputacionExcepcionFacturable && p.imputacionExcepcionFacturable.fieldApi) || '').trim(),
                values: String((p.imputacionExcepcionFacturable && p.imputacionExcepcionFacturable.values) || '').trim()
            },
            extraFilters: Array.isArray(p.extraFilters)
                ? p.extraFilters.slice(0, 8).map((f) => ({
                      objectApi: String(f.objectApi || 'Case'),
                      fieldApi: String(f.fieldApi || '').trim(),
                      values: String(f.values || '').trim(),
                      effect: String(f.effect || 'excepcionFacturable')
                  }))
                : []
        };
    } catch (e) {
        return { ...EMPTY_RULES, extraFilters: [] };
    }
}

function parseValueList(raw) {
    if (!raw) return [];
    return String(raw)
        .split(/[,;\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);
}

/** Cache global por contenido JSON: evita JSON.parse por fila por evaluación. */
const _caseRuleFieldsParseCache = new Map();
const _CASE_RULE_FIELDS_CACHE_MAX = 256;

function getCaseRuleFieldsParsed(row) {
    if (!row) return null;
    if (row.caseRuleFields && typeof row.caseRuleFields === 'object') {
        return row.caseRuleFields;
    }
    const json = row.caseRuleFieldsJson;
    if (!json) return null;
    if (_caseRuleFieldsParseCache.has(json)) {
        return _caseRuleFieldsParseCache.get(json);
    }
    let parsed = null;
    try {
        parsed = JSON.parse(json);
    } catch (e) {
        parsed = null;
    }
    if (_caseRuleFieldsParseCache.size >= _CASE_RULE_FIELDS_CACHE_MAX) {
        const firstKey = _caseRuleFieldsParseCache.keys().next().value;
        if (firstKey !== undefined) {
            _caseRuleFieldsParseCache.delete(firstKey);
        }
    }
    _caseRuleFieldsParseCache.set(json, parsed);
    return parsed;
}

function readCaseField(row, fieldApi) {
    if (!fieldApi || !row) return '';
    const parsed = getCaseRuleFieldsParsed(row);
    if (parsed && parsed[fieldApi] != null) {
        return String(parsed[fieldApi]).trim();
    }
    return '';
}

function tokenMatchesAllowedValue(token, rawValue) {
    const t = String(token).trim();
    if (!t) {
        return false;
    }
    const s = String(rawValue).trim();
    if (s.toLowerCase() === t.toLowerCase()) {
        return true;
    }
    if (s.indexOf(';') < 0) {
        return false;
    }
    const parts = s.split(';');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].trim().toLowerCase() === t.toLowerCase()) {
            return true;
        }
    }
    return false;
}

function valueMatchesList(raw, allowed) {
    if (!allowed || !allowed.length || raw == null || raw === '') {
        return false;
    }
    const s = String(raw).trim();
    for (let i = 0; i < allowed.length; i++) {
        if (tokenMatchesAllowedValue(allowed[i], s)) {
            return true;
        }
    }
    return false;
}

function matchExtra(row, rules, effect) {
    for (const f of rules.extraFilters || []) {
        if (!f || !f.fieldApi || f.effect !== effect) continue;
        const raw =
            f.objectApi === 'Imputacion__c'
                ? readImputationField(row, f.fieldApi)
                : readCaseField(row, f.fieldApi);
        if (valueMatchesList(raw, parseValueList(f.values))) {
            return true;
        }
    }
    return false;
}

function readImputationField(row, fieldApi) {
    if (!fieldApi || !row) return '';
    if (row.imputationRuleFields && row.imputationRuleFields[fieldApi] != null) {
        return String(row.imputationRuleFields[fieldApi]).trim();
    }
    return '';
}

function matchesCaseNoFacturable(row, rules, amsFallback) {
    const cfg = rules.caseNoFacturable;
    if (cfg && cfg.fieldApi && cfg.values) {
        if (valueMatchesList(readCaseField(row, cfg.fieldApi), parseValueList(cfg.values))) {
            return true;
        }
    }
    return amsFallback === true;
}

/** Mismo orden que ImputacionesBillableRules.evaluateIndField (solo si hay valor en fila). */
function evaluateIndFromRow(row, rules) {
    const fieldApi = rules && rules.imputacionIndField;
    if (!fieldApi) {
        return null;
    }
    const raw = readImputationField(row, fieldApi);
    if (raw == null || raw === '') {
        return null;
    }
    const indStr = String(raw).trim().toUpperCase();
    const nfTokens = parseValueList(rules.imputacionNoFacturableValues);
    for (let i = 0; i < nfTokens.length; i++) {
        if (indStr === String(nfTokens[i]).trim().toUpperCase()) {
            return 'NF';
        }
    }
    const faTokens = parseValueList(rules.imputacionFacturableValues);
    for (let j = 0; j < faTokens.length; j++) {
        if (indStr === String(faTokens[j]).trim().toUpperCase()) {
            return 'FA';
        }
    }
    return null;
}

/** Valor en No_Facturable__c: solo lo marcado en UI. Ind_Imputacion__c consolida tras guardar. */
export function resolveConsultantNoFacturableForSave(row) {
    if (!row) {
        return false;
    }
    return row.plannedNoFacturable === true;
}

/**
 * Vista previa en vivo: replica ImputacionesBillableRules.evaluateIsNoFacturable
 * usando Criterios_Facturable_Filtros_JSON__c del centro (alinear JSON con Ind en Setup).
 */
export function evaluatePendingRowNoFacturable(row, rules) {
    if (!row) return false;
    const cfg = rules || EMPTY_RULES;

    if (row.allowsFutureDates === true) {
        return false;
    }

    const impExc = cfg.imputacionExcepcionFacturable;
    if (impExc && impExc.fieldApi) {
        if (
            valueMatchesList(
                readImputationField(row, impExc.fieldApi),
                parseValueList(impExc.values)
            )
        ) {
            return false;
        }
    }

    const caseExc = cfg.caseExcepcionFacturable;
    if (caseExc && caseExc.fieldApi) {
        if (
            valueMatchesList(readCaseField(row, caseExc.fieldApi), parseValueList(caseExc.values))
        ) {
            return false;
        }
    }

    if (matchExtra(row, cfg, 'excepcionFacturable')) {
        return false;
    }

    if (matchExtra(row, cfg, 'noFacturable')) {
        return true;
    }

    if (matchesCaseNoFacturable(row, cfg, row.isAmsManagementCase === true)) {
        return true;
    }

    const indOutcome = evaluateIndFromRow(row, cfg);
    if (indOutcome === 'NF') {
        return true;
    }
    if (indOutcome === 'FA') {
        return false;
    }

    if (row.plannedNoFacturable === true) {
        return true;
    }

    if (matchExtra(row, cfg, 'facturable')) {
        return false;
    }

    return false;
}

/** Suma horas FA/NF del lote seleccionado (preview JSON, sin llamada Apex). */
export function computePendingBillableBreakdown(rows, selectedCaseIds, fallbackDates, rules, getRowDatesForSave) {
    const selectedSet = new Set(selectedCaseIds || []);
    const dates = Array.isArray(fallbackDates) ? fallbackDates : [];
    const resolveDates =
        typeof getRowDatesForSave === 'function'
            ? getRowDatesForSave
            : () => dates;
    let fact = 0;
    let noFact = 0;
    (rows || []).forEach((row) => {
        if (!selectedSet.has(row.caseId)) {
            return;
        }
        const h = Number(row.plannedHours);
        if (!Number.isFinite(h) || h <= 0) {
            return;
        }
        const rowDates = resolveDates(row);
        const multiplier = (rowDates && rowDates.length) || 1;
        if (evaluatePendingRowNoFacturable(row, rules)) {
            noFact += h * multiplier;
        } else {
            fact += h * multiplier;
        }
    });
    return { fact, noFact, total: fact + noFact };
}

/** Casilla No fact. siempre editable en tabla. */
export function rowNoFactCheckboxLocked() {
    return false;
}
