/**
 * Helper de filtros avanzado para reportePptBuilder.
 * Mantiene paridad funcional con reporteKaufmannPivotUtils.js (mismos operadores
 * y semantica) pero opera sobre filas Excel planas {colName: value} en lugar
 * de celdas {label,value} del API de Reports.
 *
 * Si en una fase futura unificamos utilidades compartidas (refactor de Fase 5),
 * este archivo desaparece y ambos LWC consumen el mismo paquete.
 */

export const FILTER_OPERATORS = Object.freeze([
    { value: 'eq', label: 'Es igual a', needsValue: true, valueKind: 'text' },
    { value: 'neq', label: 'No es igual a', needsValue: true, valueKind: 'text' },
    { value: 'contains', label: 'Contiene', needsValue: true, valueKind: 'text' },
    { value: 'notContains', label: 'No contiene', needsValue: true, valueKind: 'text' },
    { value: 'startsWith', label: 'Empieza con', needsValue: true, valueKind: 'text' },
    { value: 'endsWith', label: 'Termina con', needsValue: true, valueKind: 'text' },
    { value: 'empty', label: 'Esta vacio', needsValue: false, valueKind: 'none' },
    { value: 'notEmpty', label: 'No esta vacio', needsValue: false, valueKind: 'none' },
    { value: 'gt', label: 'Mayor que', needsValue: true, valueKind: 'number' },
    { value: 'gte', label: 'Mayor o igual que', needsValue: true, valueKind: 'number' },
    { value: 'lt', label: 'Menor que', needsValue: true, valueKind: 'number' },
    { value: 'lte', label: 'Menor o igual que', needsValue: true, valueKind: 'number' },
    { value: 'between', label: 'Entre (rango)', needsValue: true, valueKind: 'range' }
]);

export const FILTER_OPERATOR_MAP = FILTER_OPERATORS.reduce((acc, op) => { acc[op.value] = op; return acc; }, {});

export function resolveFilterOperator(filter) {
    if (!filter) return 'eq';
    const op = filter.operator || filter.op || 'eq';
    return FILTER_OPERATOR_MAP[op] ? op : 'eq';
}

function toNumeric(raw) {
    if (raw === null || raw === undefined || raw === '') return NaN;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'object') {
        const v = raw.value;
        if (typeof v === 'number') return v;
        if (v !== undefined && v !== null && v !== '') {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        const lbl = raw.label;
        if (lbl !== undefined && lbl !== null) {
            const cleaned = String(lbl).replace(/[^0-9,.\-]/g, '').replace(',', '.');
            const n = Number(cleaned);
            if (Number.isFinite(n)) return n;
        }
        return NaN;
    }
    const cleaned = String(raw).replace(/[^0-9,.\-]/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
}

function toText(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'object') {
        if (raw.label !== undefined && raw.label !== null && raw.label !== '') return String(raw.label);
        if (raw.value !== undefined && raw.value !== null) return String(raw.value);
        return '';
    }
    return String(raw);
}

/**
 * Evalua si un valor de celda Excel satisface un filtro avanzado.
 * - cell: valor de celda (string/number/Date/objeto Excel)
 * - filter: { column, operator, value, value2 } o legacy { column, value } (eq implicito)
 */
export function matchesFilterAdvanced(cell, filter) {
    if (!filter) return true;
    const operator = resolveFilterOperator(filter);
    const spec = FILTER_OPERATOR_MAP[operator];
    const cellText = toText(cell).trim();
    const cellTextLower = cellText.toLowerCase();

    if (operator === 'empty') return cellText === '';
    if (operator === 'notEmpty') return cellText !== '';

    const rawValue = filter.value !== undefined ? filter.value : filter.filterValue;
    if (spec && spec.needsValue && (rawValue === undefined || rawValue === null || String(rawValue) === '')) {
        return true;
    }
    const v1 = String(rawValue ?? '').trim().toLowerCase();

    switch (operator) {
        case 'eq': return cellTextLower === v1;
        case 'neq': return cellTextLower !== v1;
        case 'contains': return cellTextLower.includes(v1);
        case 'notContains': return !cellTextLower.includes(v1);
        case 'startsWith': return cellTextLower.startsWith(v1);
        case 'endsWith': return cellTextLower.endsWith(v1);
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const cn = toNumeric(cell);
            const vn = toNumeric(rawValue);
            if (!Number.isFinite(cn) || !Number.isFinite(vn)) return false;
            if (operator === 'gt') return cn > vn;
            if (operator === 'gte') return cn >= vn;
            if (operator === 'lt') return cn < vn;
            return cn <= vn;
        }
        case 'between': {
            const cn = toNumeric(cell);
            const v2 = filter.value2 !== undefined ? filter.value2 : filter.filterValue2;
            const lo = toNumeric(rawValue);
            const hi = toNumeric(v2);
            if (!Number.isFinite(cn) || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
            const min = Math.min(lo, hi);
            const max = Math.max(lo, hi);
            return cn >= min && cn <= max;
        }
        default:
            return cellTextLower === v1;
    }
}

export function isFilterUsable(filter) {
    if (!filter || !filter.column) return false;
    if (filter.column === 'TODOS') return false;
    const operator = resolveFilterOperator(filter);
    const spec = FILTER_OPERATOR_MAP[operator];
    if (!spec) return false;
    if (!spec.needsValue) return true;
    const v = filter.value !== undefined ? filter.value : filter.filterValue;
    if (v === undefined || v === null || String(v).trim() === '' || String(v) === 'TODOS') return false;
    if (operator === 'between') {
        const v2 = filter.value2 !== undefined ? filter.value2 : filter.filterValue2;
        if (v2 === undefined || v2 === null || String(v2).trim() === '') return false;
    }
    return true;
}
