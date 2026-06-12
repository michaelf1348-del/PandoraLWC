import {
    buildAdminCalcTransparencyModel,
    calcTransparencyHasWarnings,
    CHILE_HOLIDAYS_LIST_LAST_REVIEW_ISO,
    formatMonitorPlainDateEs,
    MONITOR_POLICY_LINKS
} from '../imputacionesAMSMonitorTransparency';
import { openImputationCenterMonitorModal, tabValueFromMonitorActiveEvent } from '../imputacionesAMSMonitorModal';
import {
    CHILE_FIXED_HOLIDAY_MM_DD,
    FACTURABLE_TARGET_PCT_CODE,
    JORNADA_OBJETIVO_HORAS,
    MONTH_NAMES
} from '../imputacionesAMSSharedConstants';

describe('imputacionesAMS — Monitor (lógica pura, sin montar LWC)', () => {
    describe('buildAdminCalcTransparencyModel', () => {
        it('devuelve null si el usuario no es administrador de imputación', () => {
            const m = buildAdminCalcTransparencyModel({
                isImputationAdmin: false,
                calendarMonthDate: new Date(2026, 4, 1),
                imputationCenterSettings: {},
                monthHasBreakdown: false,
                monthlyBreakdownIsEstimated: false
            });
            expect(m).toBeNull();
        });

        it('para mayo 2026 calcula días hábiles, festivos y metas alineados con la lista fija Chile', () => {
            const m = buildAdminCalcTransparencyModel({
                isImputationAdmin: true,
                calendarMonthDate: new Date(2026, 4, 15),
                imputationCenterSettings: {},
                monthHasBreakdown: false,
                monthlyBreakdownIsEstimated: false
            });
            expect(m).not.toBeNull();

            expect(m.monthTitle).toBe('Mayo 2026');
            expect(m.monthYearKey).toBe('2026-05');
            expect(m.calendarDays).toBe(31);
            expect(m.weekendCount).toBe(10);
            expect(m.holidayCount).toBe(2);
            expect(m.businessDays).toBe(19);
            expect(m.jornada).toBe(8);
            expect(m.pct).toBeNull();

            expect(m.metaHoras).toBe(152);
            expect(m.metaHorasFormatted).toBe('152 h');
            expect(m.metaFacturableFormatted).toBe('\u2014');

            const holidayKeys = m.holidayRows.map((r) => r.key);
            expect(holidayKeys).toContain('2026-05-01');
            expect(holidayKeys).toContain('2026-05-21');

            expect(m.chartLogicKey).toBe('none');
            expect(m.chartLogicLabel).toContain('Sin horas imputadas');

            expect(m.warnings).toEqual([]);
            expect(calcTransparencyHasWarnings(m)).toBe(false);
        });

        it('usa jornada y % del objeto operativo en el desglose del monitor', () => {
            const m = buildAdminCalcTransparencyModel({
                isImputationAdmin: true,
                calendarMonthDate: new Date(2026, 4, 1),
                imputationCenterSettings: {
                    workdayTargetHours: 7.5,
                    monthlyFacturableTargetPct: 80
                },
                monthHasBreakdown: false,
                monthlyBreakdownIsEstimated: false
            });
            expect(m.jornada).toBe(7.5);
            expect(m.pct).toBe(80);
            expect(m.metaHoras).toBeCloseTo(19 * 7.5, 5);
            expect(calcTransparencyHasWarnings(m)).toBe(false);
        });

        it('muestra avisos de reglas de fin de semana y festivos bloqueados', () => {
            const m = buildAdminCalcTransparencyModel({
                isImputationAdmin: true,
                calendarMonthDate: new Date(2026, 4, 1),
                imputationCenterSettings: {
                    allowWeekendImputation: false,
                    allowHolidayImputation: false
                },
                monthHasBreakdown: false,
                monthlyBreakdownIsEstimated: false
            });
            expect(m.warnings).toHaveLength(2);
            expect(calcTransparencyHasWarnings(m)).toBe(true);
        });

        it('expone fecha de revision de festivos y enlaces de politica', () => {
            const m = buildAdminCalcTransparencyModel({
                isImputationAdmin: true,
                calendarMonthDate: new Date(2026, 4, 1),
                imputationCenterSettings: {},
                monthHasBreakdown: false,
                monthlyBreakdownIsEstimated: false
            });
            expect(m.holidayListLastReviewIso).toBe(CHILE_HOLIDAYS_LIST_LAST_REVIEW_ISO);
            expect(m.holidayListLastReviewDisplay).toBe('8 de Mayo de 2026');
            expect(Array.isArray(m.policyLinks)).toBe(true);
            expect(m.policyLinks.length).toBeGreaterThanOrEqual(3);
            /* Subcadena ASCII: evita fallos si el .js se abre y guarda con otra codepage en Windows. */
            expect(m.internalPolicyNote).toContain('documentadla en vuestra wiki o intranet');
        });
    });

    describe('Monitor modal — funciones puras', () => {
        it('tabValueFromMonitorActiveEvent lee value del target', () => {
            expect(tabValueFromMonitorActiveEvent({ target: { value: 'info' } })).toBe('info');
            expect(tabValueFromMonitorActiveEvent({ target: { value: 'calc' } })).toBe('calc');
            expect(tabValueFromMonitorActiveEvent({ target: {} })).toBeNull();
        });

        it('openImputationCenterMonitorModal reinicia pestaña y marca modal abierto solo si es admin', () => {
            expect(openImputationCenterMonitorModal(false)).toEqual({ apply: false });
            expect(openImputationCenterMonitorModal(true)).toEqual({
                apply: true,
                monitorModalTab: 'calc',
                imputationCenterSettingsOpen: true
            });
        });
    });
});

describe('imputacionesAMS — formatMonitorPlainDateEs', () => {
    it('devuelve raya tipografica si falta ISO', () => {
        expect(formatMonitorPlainDateEs(null)).toBe('\u2014');
        expect(formatMonitorPlainDateEs('')).toBe('\u2014');
    });

    it('formatea YYYY-MM-DD a texto espanol con MONTH_NAMES', () => {
        expect(formatMonitorPlainDateEs('2026-01-01')).toBe(`1 de ${MONTH_NAMES[0]} de 2026`);
        expect(formatMonitorPlainDateEs('2026-12-31')).toBe(`31 de ${MONTH_NAMES[11]} de 2026`);
    });

    it('devuelve el string original si el formato no es valido', () => {
        expect(formatMonitorPlainDateEs('2026-13-01')).toBe('2026-13-01');
        expect(formatMonitorPlainDateEs('no-iso')).toBe('no-iso');
    });
});

describe('imputacionesAMS — buildAdminCalcTransparencyModel (ramas de grafico)', () => {
    const baseArgs = {
        isImputationAdmin: true,
        calendarMonthDate: new Date(2026, 0, 10),
        imputationCenterSettings: {}
    };

    it('prioriza aggregate cuando hay desglose mensual', () => {
        const m = buildAdminCalcTransparencyModel({
            ...baseArgs,
            monthHasBreakdown: true,
            monthlyBreakdownIsEstimated: true
        });
        expect(m.chartLogicKey).toBe('aggregate');
        expect(m.chartLogicLabel).toContain('Imputacion__c');
    });

    it('usa estimated cuando no hay desglose pero si estimacion', () => {
        const m = buildAdminCalcTransparencyModel({
            ...baseArgs,
            monthHasBreakdown: false,
            monthlyBreakdownIsEstimated: true
        });
        expect(m.chartLogicKey).toBe('estimated');
        expect(m.chartLogicLabel).toContain(String(FACTURABLE_TARGET_PCT_CODE));
    });

    it('mantiene none sin desglose ni estimacion', () => {
        const m = buildAdminCalcTransparencyModel({
            ...baseArgs,
            monthHasBreakdown: false,
            monthlyBreakdownIsEstimated: false
        });
        expect(m.chartLogicKey).toBe('none');
    });
});

describe('imputacionesImportExportUtil', () => {
    it('detecta filas duplicadas exactas en importacion', () => {
        const a = {
            caseNumber: '0001',
            fecha: '2026-05-10',
            hours: 2,
            comment: 'x',
            noFacturable: false
        };
        const parsed = [a, { ...a }, { ...a, hours: 3 }];
        expect(importLineFingerprint(a)).toBe(importLineFingerprint({ ...a }));
        expect(countExactDuplicateImportLines(parsed)).toBe(1);
    });

    it('genera CSV de exportacion con cabecera esperada', () => {
        const csv = buildExportCsvContent([
            {
                caseNumber: '00017359',
                hours: 3,
                isoDate: '2026-05-05',
                noFacturable: false,
                comment: 'test',
                imputationId: 'a01xx0000000001AAA'
            }
        ]);
        expect(csv).toContain('CaseNumber;Horas;Fecha;NoFacturable;Comentario;ImputacionId');
        expect(csv).toContain('00017359');
        expect(csv).toContain('a01xx0000000001AAA');
    });
});

import {
    panelMetaTextLooksCorrupt,
    repairPanelMetaCopyJson,
    repairPanelMetaFromParsed
} from '../imputacionesPanelMetaUtil';
import { coerceOperativeThemeSettings, resolveChartColorsFromSettings } from '../imputacionesAMSThemeUtil';

describe('imputacionesPanelMetaUtil', () => {
    it('repara JSON global con ?? o Recin', () => {
        const raw = '{"msg0":"Que comiencen ?? Recin calentando","badge0":"??"}';
        const repaired = JSON.parse(repairPanelMetaCopyJson(raw));
        expect(repaired.msg0).toContain('Reci\u00e9n');
        expect(repaired.msg0).not.toContain('??');
    });

    it('repara textos con ?? o Recin y conserva mensajes UTF-8 validos', () => {
        const repaired = repairPanelMetaFromParsed({
            msg0: 'Que comiencen los juegos del hambre ??. Recin calentando motores para el mes.',
            badge0: 'Juegos del Hambre ??'
        });
        expect(panelMetaTextLooksCorrupt(repaired.msg0)).toBe(false);
        expect(repaired.msg0).toContain('Reci\u00e9n');
        expect(repaired.msg0).not.toContain('??');
        expect(repaired.badge0).not.toContain('??');
        expect(repaired.badge0).toContain('Juegos del Hambre');
    });
});

describe('imputacionesAMSThemeUtil', () => {
    it('aplica colores de grafico desde settings operativos', () => {
        const s = coerceOperativeThemeSettings({
            chartColorFacturable: '#15803D',
            chartColorNoFacturable: '#E90C0C',
            chartColorMetaProgress: '#3C00C7'
        });
        const c = resolveChartColorsFromSettings(s);
        expect(c.fact).toBe('#15803D');
        expect(c.noFact).toBe('#E90C0C');
        expect(c.meta).toBe('#3C00C7');
    });
});

describe('imputacionesAMS — constantes compartidas', () => {
    it('expone jornada y porcentaje facturable objetivo esperados', () => {
        expect(JORNADA_OBJETIVO_HORAS).toBe(8);
        expect(FACTURABLE_TARGET_PCT_CODE).toBe(85);
        expect(MONTH_NAMES).toHaveLength(12);
    });

    it('incluye festivos fijos Chile clave (mes-dia)', () => {
        expect(CHILE_FIXED_HOLIDAY_MM_DD.has('01-01')).toBe(true);
        expect(CHILE_FIXED_HOLIDAY_MM_DD.has('05-01')).toBe(true);
        expect(CHILE_FIXED_HOLIDAY_MM_DD.has('05-21')).toBe(true);
        expect(CHILE_FIXED_HOLIDAY_MM_DD.has('09-18')).toBe(true);
    });
});

describe('imputacionesAMS — MONITOR_POLICY_LINKS', () => {
    it('cada enlace tiene key, label y href https', () => {
        expect(Array.isArray(MONITOR_POLICY_LINKS)).toBe(true);
        MONITOR_POLICY_LINKS.forEach((link) => {
            expect(link.key).toEqual(expect.any(String));
            expect(link.label.length).toBeGreaterThan(3);
            expect(link.href).toMatch(/^https:\/\//);
        });
    });
});
