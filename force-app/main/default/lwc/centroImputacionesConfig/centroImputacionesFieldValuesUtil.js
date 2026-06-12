/** Utilidades para editores de valores segun tipo de campo (picklist vs texto libre). */

const PICKLIST_TYPES = new Set(['Picklist', 'Multipicklist', 'Boolean']);

export function getFieldDataType(objectInfo, fieldApi) {
    if (!objectInfo?.fields || !fieldApi) {
        return null;
    }
    const f = objectInfo.fields[fieldApi];
    return f?.dataType || null;
}

export function buildPicklistValueOptions(picklistFieldValues, fieldApi) {
    if (!picklistFieldValues || !fieldApi) {
        return [];
    }
    const block = picklistFieldValues[fieldApi];
    if (!block?.values) {
        return [];
    }
    return block.values
        .filter((v) => v && v.value != null)
        .map((v) => ({ label: v.label || v.value, value: v.value }));
}

export function parseValuesList(raw) {
    if (raw == null || raw === '') {
        return [];
    }
    const s = String(raw).trim();
    if (!s) {
        return [];
    }
    if (s.includes(';')) {
        return s
            .split(';')
            .map((p) => p.trim())
            .filter(Boolean);
    }
    if (s.includes('\n')) {
        return s
            .split(/\r?\n/)
            .map((p) => p.trim())
            .filter(Boolean);
    }
    if (s.includes(',')) {
        return s
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
    }
    return [s];
}

export function joinValuesList(arr) {
    if (!Array.isArray(arr) || !arr.length) {
        return '';
    }
    return arr
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join('; ');
}

/**
 * @returns {{ valueMode: 'picklist'|'multipicklist'|'text', valueOptions: Array, selectedValues: Array }}
 */
export function buildValueEditorState(fieldApi, valuesRaw, objectInfo, picklistFieldValues) {
    const dataType = getFieldDataType(objectInfo, fieldApi);
    const selectedValues = parseValuesList(valuesRaw);
    if (dataType && PICKLIST_TYPES.has(dataType)) {
        const valueOptions = buildPicklistValueOptions(picklistFieldValues, fieldApi);
        if (valueOptions.length) {
            return {
                valueMode: dataType === 'Multipicklist' ? 'multipicklist' : 'picklist',
                valueOptions,
                selectedValues
            };
        }
    }
    return {
        valueMode: 'text',
        valueOptions: [],
        selectedValues
    };
}

export function enrichFilterRowForUi(filterRow, objectInfo, picklistFieldValues) {
    const editor = buildValueEditorState(
        filterRow.fieldApi,
        filterRow.values,
        objectInfo,
        picklistFieldValues
    );
    return {
        ...filterRow,
        ...editor,
        usePicklist: editor.valueMode === 'picklist',
        useMultipicklist: editor.valueMode === 'multipicklist',
        useTextValues: editor.valueMode === 'text'
    };
}
