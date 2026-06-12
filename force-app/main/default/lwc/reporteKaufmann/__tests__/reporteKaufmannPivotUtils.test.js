import { computeVirtualCellValue, getRowsForSheet, calculatePivotData, extractFirstEuDateTimeBlock, matchesFilterAdvanced, isFilterUsable } from '../reporteKaufmannPivotUtils';

const minimalParsed = {
    reportMetadata: { detailColumns: ['Amount', 'Name'] },
    factMap: { 'T!T': { rows: [] } }
};

describe('reporteKaufmannPivotUtils', () => {
    describe('computeVirtualCellValue', () => {
        it('concatena texto', () => {
            const row = { dataCells: [{ label: 'A' }, { label: 'B' }] };
            const col = {
                vcDef: { type: 'text', colA: 'Amount', colB: 'Name', op: ' - ' }
            };
            const out = computeVirtualCellValue(row, col, minimalParsed);
            expect(out.label).toContain('A');
            expect(out.label).toContain('B');
        });

        it('extrae con regex (grupo capturador)', () => {
            const row = { dataCells: [{ label: 'TOTAL-455' }] };
            const col = {
                vcDef: { type: 'regex', colA: 'Amount', pattern: '\\d+$', captureGroup: 0, flags: '' }
            };
            const parsed = { reportMetadata: { detailColumns: ['Amount'] }, factMap: { 'T!T': { rows: [] } } };
            const out = computeVirtualCellValue(row, col, parsed);
            expect(out.value).toBe('455');
        });

        it('divide texto y devuelve la parte solicitada', () => {
            const row = { dataCells: [{ label: 'A|B|C' }] };
            const col = {
                vcDef: { type: 'split', colA: 'Amount', delimiter: '|', partIndex: 1 }
            };
            const parsed = { reportMetadata: { detailColumns: ['Amount'] }, factMap: { 'T!T': { rows: [] } } };
            const out = computeVirtualCellValue(row, col, parsed);
            expect(out.value).toBe('B');
        });

        it('subcadena con longitud', () => {
            const row = { dataCells: [{ label: 'abcdef' }] };
            const col = {
                vcDef: { type: 'substring', colA: 'Amount', start: 2, length: 2 }
            };
            const parsed = { reportMetadata: { detailColumns: ['Amount'] }, factMap: { 'T!T': { rows: [] } } };
            const out = computeVirtualCellValue(row, col, parsed);
            expect(out.value).toBe('cd');
        });

        it('extractFirstEuDateTimeBlock recorta ante el segundo DD/MM/AAAA HH:MM:SS', () => {
            const concat = `02/05/2026 17:25:14 - Julia (Reporte avance) Parte uno
27/04/2026 08:27:19 - Julia (Reporte avance) Parte dos`;
            expect(extractFirstEuDateTimeBlock(concat)).toBe('02/05/2026 17:25:14 - Julia (Reporte avance) Parte uno');
        });

        it('extractFirstEuDateTimeBlock sin segundo bloque devuelve todo', () => {
            const one = '02/05/2026 17:25:14 - Solo esto';
            expect(extractFirstEuDateTimeBlock(one)).toBe(one);
        });

        it('columna virtual firstTimestampBlock', () => {
            const concat = `01/01/2026 10:00:00 - X
02/01/2026 11:00:00 - Y`;
            const row = { dataCells: [{ label: concat }] };
            const col = { vcDef: { type: 'firstTimestampBlock', colA: 'Amount' } };
            const parsed = { reportMetadata: { detailColumns: ['Amount'] }, factMap: { 'T!T': { rows: [] } } };
            const out = computeVirtualCellValue(row, col, parsed);
            expect(out.value).toBe('01/01/2026 10:00:00 - X');
        });
    });

    describe('getRowsForSheet', () => {
        it('devuelve filas del factMap', () => {
            const r1 = { dataCells: [{ label: 'x' }] };
            const parsed = {
                reportMetadata: { detailColumns: ['F'] },
                factMap: { 'T!T': { rows: [r1] } }
            };
            const rows = getRowsForSheet({ filters: {}, settings: {}, columns: [] }, parsed);
            expect(rows.length).toBe(1);
        });

        it('filtra por valor de columna', () => {
            const rows = [
                { dataCells: [{ label: 'Uno' }] },
                { dataCells: [{ label: 'Dos' }] }
            ];
            const parsed = {
                reportMetadata: { detailColumns: ['F'] },
                factMap: { 'T!T': { rows } }
            };
            const sheet = {
                filters: { filterColumn: 'F', filterValue: 'Dos' },
                settings: {},
                columns: []
            };
            const out = getRowsForSheet(sheet, parsed);
            expect(out.length).toBe(1);
            expect(out[0].dataCells[0].label).toBe('Dos');
        });

        it('aplica múltiples filtros en AND', () => {
            const rows = [
                { dataCells: [{ label: 'Uno' }, { label: 'Activo' }] },
                { dataCells: [{ label: 'Uno' }, { label: 'Inactivo' }] },
                { dataCells: [{ label: 'Dos' }, { label: 'Activo' }] }
            ];
            const parsed = {
                reportMetadata: { detailColumns: ['F1', 'F2'] },
                factMap: { 'T!T': { rows } }
            };
            const sheet = {
                filters: {
                    items: [
                        { filterColumn: 'F1', filterValue: 'Uno' },
                        { filterColumn: 'F2', filterValue: 'Activo' }
                    ]
                },
                settings: {},
                columns: []
            };
            const out = getRowsForSheet(sheet, parsed);
            expect(out.length).toBe(1);
            expect(out[0].dataCells[0].label).toBe('Uno');
            expect(out[0].dataCells[1].label).toBe('Activo');
        });

        it('permite OR entre condiciones', () => {
            const rows = [
                { dataCells: [{ label: 'Uno' }, { label: 'Activo' }] },
                { dataCells: [{ label: 'Uno' }, { label: 'Inactivo' }] },
                { dataCells: [{ label: 'Dos' }, { label: 'Activo' }] }
            ];
            const parsed = {
                reportMetadata: { detailColumns: ['F1', 'F2'] },
                factMap: { 'T!T': { rows } }
            };
            const sheet = {
                filters: {
                    items: [
                        { filterColumn: 'F1', filterValue: 'Dos' },
                        { filterColumn: 'F2', filterValue: 'Inactivo', logic: 'OR' }
                    ]
                },
                settings: {},
                columns: []
            };
            const out = getRowsForSheet(sheet, parsed);
            expect(out.length).toBe(2);
        });
    });

    describe('matchesFilterAdvanced', () => {
        const cell = (label) => ({ label });

        it('operador eq por defecto (sin operator)', () => {
            expect(matchesFilterAdvanced(cell('Cerrado'), { filterValue: 'cerrado' })).toBe(true);
            expect(matchesFilterAdvanced(cell('Cerrado'), { filterValue: 'abierto' })).toBe(false);
        });

        it('contains / startsWith / endsWith', () => {
            expect(matchesFilterAdvanced(cell('Reporte de avance'), { operator: 'contains', filterValue: 'avance' })).toBe(true);
            expect(matchesFilterAdvanced(cell('Reporte de avance'), { operator: 'startsWith', filterValue: 'reporte' })).toBe(true);
            expect(matchesFilterAdvanced(cell('Reporte de avance'), { operator: 'endsWith', filterValue: 'avance' })).toBe(true);
            expect(matchesFilterAdvanced(cell('Otra cosa'), { operator: 'contains', filterValue: 'avance' })).toBe(false);
        });

        it('empty / notEmpty', () => {
            expect(matchesFilterAdvanced(cell(''), { operator: 'empty' })).toBe(true);
            expect(matchesFilterAdvanced(cell('algo'), { operator: 'empty' })).toBe(false);
            expect(matchesFilterAdvanced(cell('algo'), { operator: 'notEmpty' })).toBe(true);
        });

        it('comparadores numericos', () => {
            expect(matchesFilterAdvanced({ value: 10 }, { operator: 'gt', filterValue: 5 })).toBe(true);
            expect(matchesFilterAdvanced({ value: 10 }, { operator: 'lte', filterValue: 10 })).toBe(true);
            expect(matchesFilterAdvanced({ value: 10 }, { operator: 'lt', filterValue: 5 })).toBe(false);
        });

        it('between con rango', () => {
            expect(matchesFilterAdvanced({ value: 7 }, { operator: 'between', filterValue: 5, filterValue2: 10 })).toBe(true);
            expect(matchesFilterAdvanced({ value: 11 }, { operator: 'between', filterValue: 5, filterValue2: 10 })).toBe(false);
        });

        it('isFilterUsable distingue filtros incompletos', () => {
            expect(isFilterUsable({ filterColumn: '', filterValue: 'x' })).toBe(false);
            expect(isFilterUsable({ filterColumn: 'C', operator: 'empty' })).toBe(true);
            expect(isFilterUsable({ filterColumn: 'C', operator: 'between', filterValue: 1 })).toBe(false);
            expect(isFilterUsable({ filterColumn: 'C', operator: 'between', filterValue: 1, filterValue2: 5 })).toBe(true);
        });
    });

    describe('calculatePivotData', () => {
        it('agrupa COUNT por etiqueta', () => {
            const rows = [
                { dataCells: [{ label: 'A' }] },
                { dataCells: [{ label: 'A' }] },
                { dataCells: [{ label: 'B' }] }
            ];
            const parsed = { reportMetadata: { detailColumns: ['G'] } };
            const baseColumns = [{ apiName: 'G', label: 'G' }];
            const sub = {
                groupByField: 'G',
                operation: 'COUNT',
                sortBy: 'LABEL',
                sortDirection: 'ASC'
            };
            const res = calculatePivotData(rows, sub, parsed, baseColumns);
            expect(res.data.find(d => d.label === 'A').value).toBe(2);
            expect(res.data.find(d => d.label === 'B').value).toBe(1);
        });
    });
});
