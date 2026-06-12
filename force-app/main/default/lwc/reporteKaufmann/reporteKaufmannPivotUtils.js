/**
 * Logica pura de filas de detalle, ordenacion y agregaciones tipo pivot.
 * Depende solo del JSON del reporte y de la definicion de columnas base.
 */

/**
 * Operadores soportados por el motor de filtros avanzado.
 * Compatibilidad: si un filtro legacy no trae `operator`, se asume 'eq'.
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
    { value: 'between', label: 'Entre (rango)', needsValue: true, valueKind: 'range' },
    /* V3 (AutoFiltro): filtro multi-valor por columna. filterValue es array (o string '|'-separado). */
    { value: 'in', label: 'Es uno de', needsValue: true, valueKind: 'list' },
    { value: 'notIn', label: 'No es ninguno de', needsValue: true, valueKind: 'list' }
]);

/** Mapa operador -> spec, para lookup rapido. */
export const FILTER_OPERATOR_MAP = FILTER_OPERATORS.reduce((acc, op) => { acc[op.value] = op; return acc; }, {});

/** Resuelve el operador efectivo (con compatibilidad legacy). */
export function resolveFilterOperator(filter) {
    if (!filter) return 'eq';
    const op = filter.operator || filter.op || 'eq';
    return FILTER_OPERATOR_MAP[op] ? op : 'eq';
}

/** Convierte una celda a numero, intentando con value/label y normalizando ',' decimal europeo. */
function toNumeric(cellOrValue) {
    if (cellOrValue === null || cellOrValue === undefined) return NaN;
    if (typeof cellOrValue === 'number') return cellOrValue;
    if (typeof cellOrValue === 'object') {
        const v = cellOrValue.value;
        if (typeof v === 'number') return v;
        if (v !== undefined && v !== null && v !== '') {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        const lbl = cellOrValue.label;
        if (lbl !== undefined && lbl !== null) {
            const cleaned = String(lbl).replace(/[^0-9,.\-]/g, '').replace(',', '.');
            const n = Number(cleaned);
            if (Number.isFinite(n)) return n;
        }
        return NaN;
    }
    const cleaned = String(cellOrValue).replace(/[^0-9,.\-]/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
}

/** Devuelve el texto representativo de una celda (label si existe, si no value). */
function toTextFromCell(cell) {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'object') {
        if (cell.label !== undefined && cell.label !== null && cell.label !== '') return String(cell.label);
        if (cell.value !== undefined && cell.value !== null) return String(cell.value);
        return '';
    }
    return String(cell);
}

/**
 * Evalua si una celda satisface un filtro avanzado. Es la fuente unica de verdad.
 * `cell` puede ser una celda del reporte ({label,value}), un valor primitivo, o un objeto del Excel.
 */
export function matchesFilterAdvanced(cell, filter) {
    const operator = resolveFilterOperator(filter);
    const spec = FILTER_OPERATOR_MAP[operator];
    const cellText = toTextFromCell(cell).trim();
    const cellTextLower = cellText.toLowerCase();

    if (operator === 'empty') return cellText === '';
    if (operator === 'notEmpty') return cellText !== '';

    const rawValue = filter.filterValue !== undefined ? filter.filterValue : filter.value;
    /* V3: filtros multi-valor (in/notIn) — toleran rawValue como array o string '|'-separado. */
    if (operator === 'in' || operator === 'notIn') {
        const arr = Array.isArray(rawValue)
            ? rawValue
            : (rawValue === null || rawValue === undefined ? [] : String(rawValue).split('|'));
        const lowerArr = arr.map(x => String(x ?? '').trim().toLowerCase()).filter(s => s.length > 0);
        if (!lowerArr.length) return true; /* lista vacía = no filtra */
        const isIn = lowerArr.includes(cellTextLower);
        return operator === 'in' ? isIn : !isIn;
    }
    if (spec && spec.needsValue && (rawValue === undefined || rawValue === null || String(rawValue) === '')) {
        /* Filtro sin valor configurado: lo dejamos pasar (no excluye nada). */
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
            const v2 = filter.filterValue2 !== undefined ? filter.filterValue2 : filter.value2;
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

/**
 * Indica si un filtro tiene la informacion minima para ser evaluado.
 * - Necesita columna SIEMPRE.
 * - Si el operador no necesita valor (empty/notEmpty), no se exige valor.
 * - Si necesita valor, debe traer filterValue (y filterValue2 para between).
 */
export function isFilterUsable(filter) {
    if (!filter || !(filter.filterColumn || filter.column)) return false;
    const operator = resolveFilterOperator(filter);
    const spec = FILTER_OPERATOR_MAP[operator];
    if (!spec) return false;
    if (!spec.needsValue) return true;
    const v = filter.filterValue !== undefined ? filter.filterValue : filter.value;
    /* V3: para in/notIn, el valor es un array o string '|'-separado. */
    if (operator === 'in' || operator === 'notIn') {
        const arr = Array.isArray(v)
            ? v
            : (v === null || v === undefined ? [] : String(v).split('|'));
        return arr.filter(x => String(x ?? '').trim().length > 0).length > 0;
    }
    if (v === undefined || v === null || String(v).trim() === '') return false;
    if (operator === 'between') {
        const v2 = filter.filterValue2 !== undefined ? filter.filterValue2 : filter.value2;
        if (v2 === undefined || v2 === null || String(v2).trim() === '') return false;
    }
    return true;
}

/** Texto hasta justo antes de la segunda aparici�n de fecha+hora europea t�pica (p. ej. historiales concatenados). */
export function extractFirstEuDateTimeBlock(str) {
    if (!str || typeof str !== 'string') return '';
    const trimmed = str.trim();
    if (!trimmed) return '';
    const re = /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/g;
    const first = re.exec(trimmed);
    if (!first) return trimmed;
    const second = re.exec(trimmed);
    if (!second) return trimmed;
    return trimmed.slice(0, second.index).trim();
}

/**
 * @param {*} row
 * @param {{ vcDef?: object }} colConfig
 * @param {*} parsedData
 * @returns {{ label: string, value: * }}
 */
export function computeVirtualCellValue(row, colConfig, parsedData) {
    const def = colConfig.vcDef;
    if (!def) return { label: '', value: '' };
    const idxA = parsedData.reportMetadata && parsedData.reportMetadata.detailColumns
        ? parsedData.reportMetadata.detailColumns.indexOf(def.colA)
        : -1;
    let valA = idxA >= 0 && row.dataCells[idxA]
        ? (row.dataCells[idxA].value !== undefined && row.dataCells[idxA].value !== null
            ? row.dataCells[idxA].value
            : row.dataCells[idxA].label)
        : null;
    let valB = def.staticB;
    if (def.colB) {
        const idxB = parsedData.reportMetadata && parsedData.reportMetadata.detailColumns
            ? parsedData.reportMetadata.detailColumns.indexOf(def.colB)
            : -1;
        valB = idxB >= 0 && row.dataCells[idxB]
            ? (row.dataCells[idxB].value !== undefined && row.dataCells[idxB].value !== null
                ? row.dataCells[idxB].value
                : row.dataCells[idxB].label)
            : null;
    }
    let result = '';
    if (def.type === 'math') {
        const nA = Number(valA) || 0;
        const nB = Number(valB) || 0;
        if (def.op === '+') result = nA + nB;
        else if (def.op === '-') result = nA - nB;
        else if (def.op === '*') result = nA * nB;
        else if (def.op === '/') result = nB !== 0 ? nA / nB : 0;
        return { label: Number(result).toLocaleString('es-ES', { minimumFractionDigits: 2 }), value: result };
    }
    const sA = valA !== null && valA !== undefined ? String(valA) : '';

    if (def.type === 'regex') {
        let piece = '';
        try {
            const pat = def.pattern !== undefined && def.pattern !== null ? String(def.pattern) : '';
            if (!pat.trim()) return { label: '', value: '' };
            const re = new RegExp(pat, def.flags || '');
            const m = re.exec(sA);
            if (m) {
                const gi = Number(def.captureGroup ?? 1);
                if (typeof m[gi] === 'string') piece = m[gi];
                else if (typeof m[0] === 'string') piece = m[0];
            }
        } catch (_e) {
            piece = '';
        }
        return { label: piece, value: piece };
    }

    if (def.type === 'firstTimestampBlock') {
        const piece = extractFirstEuDateTimeBlock(sA);
        return { label: piece, value: piece };
    }

    if (def.type === 'split') {
        const delim = def.delimiter != null ? String(def.delimiter) : ',';
        const parts = delim.length ? String(sA).split(delim) : Array.from(String(sA));
        const ix = Number(def.partIndex ?? 0);
        const raw = ix >= 0 && ix < parts.length ? parts[ix] : '';
        const piece = raw.trim ? raw.trim() : raw;
        return { label: piece, value: piece };
    }

    if (def.type === 'substring') {
        const str = String(sA);
        const start = Number.isFinite(Number(def.start)) ? Math.max(0, Number(def.start)) : 0;
        const lenRaw = def.length;
        let piece = '';
        if (lenRaw === undefined || lenRaw === null || lenRaw === '') {
            piece = str.slice(start);
        } else {
            const ln = Number(lenRaw);
            piece = Number.isFinite(ln) && ln >= 0 ? str.slice(start, start + ln) : str.slice(start);
        }
        return { label: piece, value: piece };
    }

    const sB = valB !== null && valB !== undefined ? String(valB) : '';
    const sep = def.op || ' ';
    result = `${sA}${sB ? sep : ''}${sB}`;
    return { label: result, value: result };
}

/**
 * @param {*} sheet
 * @param {*} parsedData
 * @returns {Array}
 */
export function getRowsForSheet(sheet, parsedData) {
    if (!parsedData) return [];
    const factMap = parsedData.factMap ? parsedData.factMap['T!T'] : null;
    let allRows = factMap && factMap.rows ? factMap.rows : [];

    let filteredRows = [...allRows];
    const filterItems = [];
    if (sheet && sheet.filters) {
        if (Array.isArray(sheet.filters.items)) {
            sheet.filters.items.forEach((f) => {
                if (isFilterUsable(f)) filterItems.push(f);
            });
        }
        // Compatibilidad con formato legado de filtro unico
        if (!filterItems.length && sheet.filters.filterColumn && sheet.filters.filterValue) {
            filterItems.push({ filterColumn: sheet.filters.filterColumn, filterValue: sheet.filters.filterValue, operator: 'eq' });
        }
    }
    if (filterItems.length) {
        filteredRows = allRows.filter((r) => {
            const evalFilter = (flt) => {
                const colIndex = parsedData.reportMetadata && parsedData.reportMetadata.detailColumns
                    ? parsedData.reportMetadata.detailColumns.indexOf(flt.filterColumn)
                    : -1;
                if (colIndex === -1) return true;
                const cell = r.dataCells[colIndex];
                return matchesFilterAdvanced(cell, flt);
            };
            let acc = evalFilter(filterItems[0]);
            for (let i = 1; i < filterItems.length; i++) {
                const op = filterItems[i].logic === 'OR' ? 'OR' : 'AND';
                const curr = evalFilter(filterItems[i]);
                acc = op === 'OR' ? (acc || curr) : (acc && curr);
            }
            return acc;
        });
    }

    if (sheet && sheet.settings && sheet.settings.sortBy) {
        const sortCol = sheet.columns.find(c => c.apiName === sheet.settings.sortBy);
        const sortIdx = parsedData.reportMetadata && parsedData.reportMetadata.detailColumns
            ? parsedData.reportMetadata.detailColumns.indexOf(sheet.settings.sortBy)
            : -1;

        if (sortCol || sortIdx >= 0) {
            const isDesc = sheet.settings.sortDirection === 'DESC';
            filteredRows.sort((a, b) => {
                let valA = sortCol && sortCol.isVirtual
                    ? computeVirtualCellValue(a, sortCol, parsedData).value
                    : a.dataCells[sortIdx]?.value ?? a.dataCells[sortIdx]?.label;
                let valB = sortCol && sortCol.isVirtual
                    ? computeVirtualCellValue(b, sortCol, parsedData).value
                    : b.dataCells[sortIdx]?.value ?? b.dataCells[sortIdx]?.label;

                if (typeof valA === 'string' && typeof valB === 'string') {
                    return isDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
                }
                const numA = Number(valA) || 0;
                const numB = Number(valB) || 0;
                return isDesc ? numB - numA : numA - numB;
            });
        }
    }

    return filteredRows;
}

/**
 * @param {Array} rows
 * @param {*} subConfig
 * @param {*} parsedData
 * @param {Array<{ apiName: string, label?: string, isVirtual?: boolean, vcDef?: object }>} baseColumns
 * @returns {{ data: Array<{ label: string, value: number, displayValue: string }>, total: number }}
 */
export function calculatePivotData(rows, subConfig, parsedData, baseColumns) {
    if (!parsedData) return { data: [], total: 0 };
    const gIdx = parsedData.reportMetadata && parsedData.reportMetadata.detailColumns
        ? parsedData.reportMetadata.detailColumns.indexOf(subConfig.groupByField)
        : -1;
    const gCol = baseColumns.find(c => c.apiName === subConfig.groupByField);
    if (gIdx === -1 && (!gCol || !gCol.isVirtual)) return { data: [], total: 0 };

    let mIdx = -1;
    const mCol = baseColumns.find(c => c.apiName === subConfig.metricField);
    if ((subConfig.operation === 'SUM' || subConfig.operation === 'AVG') && subConfig.metricField) {
        mIdx = parsedData.reportMetadata && parsedData.reportMetadata.detailColumns
            ? parsedData.reportMetadata.detailColumns.indexOf(subConfig.metricField)
            : -1;
    }

    const counter = {};
    let totalSum = 0;
    let totalCount = 0;

    rows.forEach(r => {
        let labelValue = 'Sin Asignar';
        if (gCol && gCol.isVirtual) {
            const vCell = computeVirtualCellValue(r, gCol, parsedData);
            labelValue = vCell.label || 'Sin Asignar';
        } else if (gIdx >= 0) {
            labelValue = r.dataCells[gIdx] && r.dataCells[gIdx].label ? r.dataCells[gIdx].label : 'Sin Asignar';
        }
        if (!counter[labelValue]) counter[labelValue] = { count: 0, sum: 0 };
        counter[labelValue].count += 1;
        totalCount += 1;

        if ((mCol && mCol.isVirtual) || mIdx >= 0) {
            let rawNum = 0;
            if (mCol && mCol.isVirtual) {
                const vCell = computeVirtualCellValue(r, mCol, parsedData);
                rawNum = Number(vCell.value) || 0;
            } else {
                const cellVal = r.dataCells[mIdx];
                if (cellVal) {
                    let valToParse = cellVal.value !== undefined && cellVal.value !== null ? cellVal.value : cellVal.label;
                    if (typeof valToParse === 'number') rawNum = valToParse;
                    else {
                        let cleanStr = String(valToParse).replace(/[^0-9.,-]/g, '').replace(',', '.');
                        rawNum = parseFloat(cleanStr);
                        if (isNaN(rawNum)) rawNum = 0;
                    }
                }
            }
            counter[labelValue].sum += rawNum;
            totalSum += rawNum;
        }
    });

    let globalTotal =
        subConfig.operation === 'COUNT'
            ? totalCount
            : subConfig.operation === 'SUM'
                ? totalSum
                : totalCount > 0
                    ? totalSum / totalCount
                    : 0;

    let dataArray = Object.keys(counter).map(key => {
        const data = counter[key];
        let finalVal = 0;
        if (subConfig.operation === 'COUNT') finalVal = data.count;
        else if (subConfig.operation === 'SUM') finalVal = data.sum;
        else if (subConfig.operation === 'AVG') finalVal = data.count > 0 ? data.sum / data.count : 0;
        const displayVal =
            subConfig.operation === 'COUNT'
                ? finalVal
                : Number(finalVal).toLocaleString('es-ES', { minimumFractionDigits: 2 });
        return { label: key, value: finalVal, displayValue: displayVal };
    });

    if (subConfig.sortBy) {
        const isDesc = subConfig.sortDirection === 'DESC';
        dataArray.sort((a, b) => {
            if (subConfig.sortBy === 'VALUE') {
                return isDesc ? b.value - a.value : a.value - b.value;
            }
            return isDesc
                ? String(b.label).localeCompare(String(a.label))
                : String(a.label).localeCompare(String(b.label));
        });
    }

    return { data: dataArray, total: globalTotal };
}
