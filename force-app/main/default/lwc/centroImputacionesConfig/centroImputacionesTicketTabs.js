/** Utilidades puras para el editor visual de pestanas del catalogo. */

export const TAB_TYPE_OPTIONS = [
    { label: 'Mis tickets', value: 'mine' },
    { label: 'Gestion AMS', value: 'ams' },
    { label: 'Personalizada', value: 'custom' }
];

export const FILTER_LOGIC_OPTIONS = [
    { label: 'AND (todas las condiciones)', value: 'AND' },
    { label: 'OR (cualquier condicion)', value: 'OR' }
];

export const CUSTOM_TAB_SLOTS = ['custom1', 'custom2'];

const DEFAULT_TABS = [
    { id: 'mine', label: 'Mis tickets', type: 'mine' },
    {
        id: 'ams',
        label: 'Gestion AMS',
        type: 'ams',
        supportsCreatedDateFilter: true,
        createdDateDaysBack: null,
        hidden: false,
        filterLogic: 'AND',
        filters: []
    }
];

const FILTERABLE_CASE_DATA_TYPES = new Set([
    'String',
    'Picklist',
    'Multipicklist',
    'Boolean',
    'Double',
    'Integer',
    'Long',
    'Percent',
    'Id',
    'Reference',
    'Email',
    'Phone',
    'Url',
    'TextArea'
]);

let _tabKeySeq = 0;
let _filterKeySeq = 0;

function nextTabKey() {
    _tabKeySeq += 1;
    return `tab-${_tabKeySeq}`;
}

function nextFilterKey() {
    _filterKeySeq += 1;
    return `flt-${_filterKeySeq}`;
}

function normalizeTabId(raw) {
    if (!raw) return '';
    return String(raw)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}

function normalizeFilterLogic(raw) {
    const v = String(raw || 'AND')
        .trim()
        .toUpperCase();
    return v === 'OR' ? 'OR' : 'AND';
}

export function createFilterRow(fieldApi = '', values = '', matchEmpty = false) {
    return {
        _fkey: nextFilterKey(),
        fieldApi: fieldApi || '',
        values: values || '',
        matchEmpty: matchEmpty === true
    };
}

/** Fila de filtro totalmente en blanco (se ignora al guardar). */
export function isFilterRowBlank(f) {
    if (!f) return true;
    return (
        !String(f.fieldApi || '').trim() &&
        !String(f.values || '').trim() &&
        f.matchEmpty !== true
    );
}

/** Fila utilizable en runtime: campo + (valores o incluir vacios). */
export function isFilterRowComplete(f) {
    if (!f || isFilterRowBlank(f)) return false;
    const api = String(f.fieldApi || '').trim();
    if (!api) return false;
    if (f.matchEmpty === true) return true;
    return !!String(f.values || '').trim();
}

export function hasValidFilters(filters) {
    return (filters || []).some((f) => isFilterRowComplete(f));
}

export function findIncompleteFilters(filters) {
    return (filters || []).filter((f) => !isFilterRowBlank(f) && !isFilterRowComplete(f));
}

function parseFiltersFromObject(obj) {
    const out = [];
    if (obj.filters && Array.isArray(obj.filters)) {
        for (const f of obj.filters) {
            if (!f || typeof f !== 'object') continue;
            const api = String(f.fieldApi || '').trim();
            const vals = f.values != null ? String(f.values).trim() : '';
            const matchEmpty = f.matchEmpty === true;
            if (api || vals || matchEmpty) {
                out.push(createFilterRow(api, vals, matchEmpty));
            }
        }
    }
    if (!out.length) {
        const api =
            obj.caseFieldApi != null
                ? String(obj.caseFieldApi).trim()
                : obj.campoMotivo != null
                  ? String(obj.campoMotivo).trim()
                  : obj.reasonFieldApi != null
                    ? String(obj.reasonFieldApi).trim()
                    : '';
        const vals =
            obj.caseFieldValues != null
                ? String(obj.caseFieldValues).trim()
                : obj.motivos != null
                  ? String(obj.motivos).trim()
                  : obj.reasonValues != null
                    ? String(obj.reasonValues).trim()
                    : '';
        if (api || vals) {
            out.push(createFilterRow(api, vals));
        }
        const api2 = obj.caseFieldApi2 != null ? String(obj.caseFieldApi2).trim() : '';
        const vals2 =
            obj.caseFieldValues2 != null
                ? String(obj.caseFieldValues2).trim()
                : obj.servicios != null
                  ? String(obj.servicios).trim()
                  : '';
        if (api2 || vals2) {
            out.push(createFilterRow(api2, vals2));
        }
    }
    return out.length ? out : [createFilterRow('Reason', '')];
}

function rowFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const type = String(obj.type || '')
        .trim()
        .toLowerCase();
    if (type !== 'mine' && type !== 'ams' && type !== 'custom') return null;
    const id = normalizeTabId(obj.id);
    const label = String(obj.label || '').trim();
    if (!id || !label) return null;
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) return null;

    let resolvedType = type;
    if (id === 'ams') {
        resolvedType = 'ams';
    } else if (id === 'mine') {
        resolvedType = 'mine';
    }
    const filters = resolvedType === 'mine' ? [] : parseFiltersFromObject(obj);
    const row = {
        _key: nextTabKey(),
        id,
        label: label.slice(0, 80),
        type: resolvedType,
        supportsCreatedDateFilter: obj.supportsCreatedDateFilter === true,
        createdDateDaysBack:
            obj.createdDateDaysBack != null && obj.createdDateDaysBack !== ''
                ? Number(obj.createdDateDaysBack)
                : null,
        hidden: obj.hidden === true,
        hint: obj.hint != null ? String(obj.hint).trim() : '',
        filterLogic: normalizeFilterLogic(obj.filterLogic),
        filters
    };
    if (resolvedType === 'custom' && !hasValidFilters(row.filters)) {
        return null;
    }
    return row;
}

/** Corrige tipo por id y elimina filas de filtro en blanco antes de validar o guardar. */
export function normalizeTicketTabRows(rows) {
    if (!Array.isArray(rows)) {
        return [];
    }
    return rows.map((r) => {
        if (!r) {
            return r;
        }
        let type = String(r.type || '')
            .trim()
            .toLowerCase();
        const id = normalizeTabId(r.id);
        if (id === 'ams') {
            type = 'ams';
        } else if (id === 'mine') {
            type = 'mine';
        }
        let filters = (r.filters || [])
            .filter((f) => !isFilterRowBlank(f))
            .map((f) => ({
                ...f,
                fieldApi: String(f.fieldApi || '').trim(),
                values: f.values != null ? String(f.values) : '',
                matchEmpty: f.matchEmpty === true
            }));
        if (type === 'ams') {
            filters = filters.filter((f) => isFilterRowComplete(f));
        }
        const nextFilters =
            type === 'mine'
                ? []
                : filters.length
                  ? filters
                  : type === 'ams'
                    ? []
                    : [createFilterRow('Reason', '')];
        const next = { ...r, id, type, filters: nextFilters };
        if (type === 'ams') {
            next.supportsCreatedDateFilter = true;
            next.createdDateDaysBack = null;
        }
        return next;
    });
}

export function parseTabsFromStorage(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) {
        return DEFAULT_TABS.map((t) => ({
            ...t,
            _key: nextTabKey(),
            filters: (t.filters || []).map((f) => createFilterRow(f.fieldApi, f.values))
        }));
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            return DEFAULT_TABS.map((t) => ({
                ...t,
                _key: nextTabKey(),
                filters: (t.filters || []).map((f) => createFilterRow(f.fieldApi, f.values))
            }));
        }
        const rows = [];
        const seen = new Set();
        let customCount = 0;
        for (const item of parsed) {
            const row = rowFromObject(item);
            if (!row || seen.has(row.id)) continue;
            if (row.type === 'custom') {
                customCount += 1;
                if (customCount > 2) continue;
            }
            seen.add(row.id);
            rows.push(row);
        }
        if (!rows.some((r) => r.id === 'mine')) {
            rows.unshift({
                _key: nextTabKey(),
                id: 'mine',
                label: 'Mis tickets',
                type: 'mine',
                supportsCreatedDateFilter: false,
                createdDateDaysBack: null,
                hidden: false,
                hint: '',
                filterLogic: 'AND',
                filters: []
            });
        }
        return rows.length
            ? rows
            : DEFAULT_TABS.map((t) => ({
                  ...t,
                  _key: nextTabKey(),
                  filters: (t.filters || []).map((f) => createFilterRow(f.fieldApi, f.values))
              }));
    } catch (e) {
        return DEFAULT_TABS.map((t) => ({
            ...t,
            _key: nextTabKey(),
            filters: (t.filters || []).map((f) => createFilterRow(f.fieldApi, f.values))
        }));
    }
}

export function serializeTabsToJson(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    const out = rows.map((r) => {
        const item = { id: r.id, label: r.label, type: r.type };
        if (r.hidden === true) item.hidden = true;
        if (r.supportsCreatedDateFilter) item.supportsCreatedDateFilter = true;
        if (r.createdDateDaysBack != null && r.createdDateDaysBack !== '' && !Number.isNaN(Number(r.createdDateDaysBack))) {
            item.createdDateDaysBack = Number(r.createdDateDaysBack);
        }
        if (r.hint) item.hint = r.hint;
        if (r.type === 'ams' || r.type === 'custom') {
            const logic = normalizeFilterLogic(r.filterLogic);
            if (logic === 'OR') item.filterLogic = 'OR';
            const validFilters = (r.filters || []).filter((f) => isFilterRowComplete(f));
            item.filters = validFilters.map((f) => {
                const entry = {
                    fieldApi: String(f.fieldApi).trim(),
                    values: String(f.values || '').trim()
                };
                if (f.matchEmpty === true) {
                    entry.matchEmpty = true;
                }
                return entry;
            });
        }
        return item;
    });
    return JSON.stringify(out, null, 2);
}

export function createEmptyTab(slotOrType = 'custom1') {
    if (slotOrType === 'mine' || slotOrType === 'ams') {
        const t = slotOrType;
        return {
            _key: nextTabKey(),
            id: t,
            label: t === 'mine' ? 'Mis tickets' : 'Gestion AMS',
            type: t,
            supportsCreatedDateFilter: t === 'ams',
            createdDateDaysBack: null,
            hidden: false,
            hint: '',
            filterLogic: 'AND',
            filters: t === 'mine' ? [] : t === 'ams' ? [] : [createFilterRow('Reason', '')]
        };
    }
    const slot = CUSTOM_TAB_SLOTS.includes(slotOrType) ? slotOrType : 'custom1';
    const num = slot === 'custom2' ? '2' : '1';
    return {
        _key: nextTabKey(),
        id: slot,
        label: `Personalizada ${num}`,
        type: 'custom',
        supportsCreatedDateFilter: false,
        createdDateDaysBack: null,
        hidden: false,
        hint: '',
        filterLogic: 'AND',
        filters: [createFilterRow('Reason', '')]
    };
}

export function countCustomTabs(rows) {
    if (!Array.isArray(rows)) return 0;
    return rows.filter((r) => r && r.type === 'custom').length;
}

export function hasCustomSlot(rows, slot) {
    return (rows || []).some((r) => r.type === 'custom' && r.id === slot);
}

export function validateTabsRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const seen = new Set();
    let customCount = 0;
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        const id = normalizeTabId(r?.id);
        const label = String(r?.label || '').trim();
        const type = String(r?.type || '').toLowerCase();
        if (!id || !label || !type) {
            return `Pestana ${i + 1}: faltan id, etiqueta o tipo.`;
        }
        if (!/^[a-z0-9_-]{1,40}$/.test(id)) {
            return `Pestana "${label}": id invalido.`;
        }
        if (seen.has(id)) return `Id duplicado: ${id}`;
        seen.add(id);
        if (type === 'custom') {
            customCount += 1;
            if (customCount > 2) return 'Solo se permiten dos pestanas personalizadas.';
        }
        const tabType = id === 'ams' ? 'ams' : type;
        if (tabType === 'custom') {
            const incomplete = findIncompleteFilters(r.filters);
            if (incomplete.length) {
                return `Pestana "${label}": cada filtro necesita campo Case y valores (o marcar "Incluir vacios").`;
            }
        }
        if (tabType === 'custom' && !hasValidFilters(r.filters)) {
            return `Pestana "${label}": anade al menos un filtro completo (campo + valores o solo vacios).`;
        }
    }
    if (!seen.has('mine')) return 'Debe existir una pestana con id "mine".';
    return null;
}

export function previewTabsRows(rows) {
    const err = validateTabsRows(rows);
    if (err) return `Error: ${err}`;
    if (!rows.length) return 'Vacio: al guardar se usaran Mis tickets + Gestion AMS.';
    const labels = rows.filter((t) => !t.hidden).map((t) => `${t.label} (${t.type})`);
    return `Al guardar: ${labels.length} pestana(s) visible(s) � ${labels.join(', ')}`;
}

export function buildCaseFieldOptionsFromObjectInfo(data) {
    if (!data || !data.fields) return [];
    return Object.values(data.fields)
        .filter((f) => f && f.apiName && FILTERABLE_CASE_DATA_TYPES.has(f.dataType))
        .map((f) => ({ label: `${f.label} (${f.apiName})`, value: f.apiName }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
