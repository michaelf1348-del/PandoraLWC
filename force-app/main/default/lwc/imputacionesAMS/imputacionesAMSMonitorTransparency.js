import {
    MONTH_NAMES,
    CHILE_FIXED_HOLIDAY_MM_DD,
    JORNADA_OBJETIVO_HORAS
} from './imputacionesAMSSharedConstants';

/**
 * Fecha de ultima revision de la lista de festivos fijos en codigo (YYYY-MM-DD).
 */
export const CHILE_HOLIDAYS_LIST_LAST_REVIEW_ISO = '2026-05-08';

/** Enlaces de referencia (normativa / informacion publica Chile). */
export const MONITOR_POLICY_LINKS = [
    {
        key: 'pol-dt',
        label: 'Direccion del Trabajo de Chile — portal oficial',
        href: 'https://www.dt.gob.cl/'
    },
    {
        key: 'pol-cha',
        label: 'ChileAtiende — feriados y fines de semana largo',
        href: 'https://www.chileatiende.gob.cl/fichas/10037-feriados-y-fines-de-semana-largo'
    },
    {
        key: 'pol-ley',
        label: 'Ley Chile — consulta normativa (feriados y trabajo)',
        href: 'https://www.leychile.cl/'
    }
];

function formatHoursShortMeta(h) {
    const n = Number(h);
    if (!Number.isFinite(n)) {
        return '0 h';
    }
    const t = Math.round(n * 100) / 100;
    return `${t} h`;
}

function formatDateForCalendarYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatIsoToDMY(iso) {
    if (!iso) {
        return '';
    }
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

export function formatMonitorPlainDateEs(iso) {
    if (!iso || typeof iso !== 'string') {
        return '\u2014';
    }
    const parts = iso.split('-');
    if (parts.length !== 3) {
        return iso;
    }
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if ([y, m, d].some((n) => Number.isNaN(n)) || m < 1 || m > 12) {
        return iso;
    }
    return `${d} de ${MONTH_NAMES[m - 1]} de ${y}`;
}

function parseExtraHolidayMmDd(raw) {
    const set = new Set();
    if (!raw || typeof raw !== 'string') {
        return set;
    }
    for (const token of raw.split(/[,;\n\r]+/)) {
        const t = String(token || '').trim();
        if (!t) {
            continue;
        }
        const parts = t.replace(/\//g, '-').split('-');
        if (parts.length < 2) {
            continue;
        }
        const mm = String(parts[0]).padStart(2, '0');
        const dd = String(parts[1]).padStart(2, '0');
        set.add(`${mm}-${dd}`);
    }
    return set;
}

function isHolidayMmDd(mmdd, extraHolidays) {
    if (CHILE_FIXED_HOLIDAY_MM_DD.has(mmdd)) {
        return true;
    }
    return extraHolidays && extraHolidays.has(mmdd);
}

function resolveJornada(settings) {
    const p = Number(settings?.workdayTargetHours);
    if (Number.isFinite(p) && p > 0 && p <= 24) {
        return p;
    }
    return JORNADA_OBJETIVO_HORAS;
}

function resolvePct(settings) {
    const p = Number(settings?.monthlyFacturableTargetPct);
    if (Number.isFinite(p) && p > 0 && p <= 100) {
        return p;
    }
    return null;
}

/**
 * Desglose de la meta mensual del grafico (Monitor Centro Imputaciones).
 */
export function buildAdminCalcTransparencyModel({
    isImputationAdmin,
    calendarMonthDate,
    imputationCenterSettings,
    monthHasBreakdown,
    monthlyBreakdownIsEstimated
}) {
    if (!isImputationAdmin) {
        return null;
    }
    const settings = imputationCenterSettings || {};
    const extraHolidays = parseExtraHolidayMmDd(settings.extraHolidaysMmDd);
    const year = calendarMonthDate.getFullYear();
    const month = calendarMonthDate.getMonth();
    const monthTitle = `${MONTH_NAMES[month]} ${year}`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    let weekendCount = 0;
    const holidayRows = [];
    let businessDays = 0;
    for (let day = 1; day <= lastDay; day += 1) {
        const d = new Date(year, month, day);
        const dow = d.getDay();
        const iso = formatDateForCalendarYMD(d);
        const mmdd = iso.slice(5);
        if (dow === 0 || dow === 6) {
            weekendCount += 1;
        } else if (isHolidayMmDd(mmdd, extraHolidays)) {
            holidayRows.push({
                key: iso,
                label: `${formatIsoToDMY(iso)} \u00b7 festivo (${mmdd})`
            });
        } else {
            businessDays += 1;
        }
    }
    const jornada = resolveJornada(settings);
    const pct = resolvePct(settings);
    const metaHoras = businessDays * jornada;
    const metaFacturable = pct != null ? metaHoras * (pct / 100) : null;
    const warnings = [];
    if (settings.allowWeekendImputation === false) {
        warnings.push({
            key: 'rule-weekend-off',
            text: 'Regla activa: no se permite imputar en fin de semana.'
        });
    }
    if (settings.allowHolidayImputation === false) {
        warnings.push({
            key: 'rule-holiday-off',
            text: 'Regla activa: no se permite imputar en dias festivos.'
        });
    }
    let chartLogicKey = 'none';
    if (monthHasBreakdown) {
        chartLogicKey = 'aggregate';
    } else if (monthlyBreakdownIsEstimated) {
        chartLogicKey = 'estimated';
    }
    const chartLogicLabel =
        chartLogicKey === 'aggregate'
            ? 'Hay desglose facturable / no facturable en Imputacion__c: el grafico usa esos importes.'
            : chartLogicKey === 'estimated'
              ? pct != null
                  ? `Sin desglose en Imputacion__c: se estima facturable = total del mes \u00d7 ${pct} % y el resto no facturable.`
                  : 'Sin desglose en Imputacion__c: configure el % meta facturable en el centro para estimar.'
              : 'Sin horas imputadas este mes o sin estimacion aplicable.';
    const monthYearKey = `${year}-${String(month + 1).padStart(2, '0')}`;
    return {
        monthTitle,
        monthYearKey,
        referenceMonthExplanation:
            'Este desglose usa el mismo mes que el calendario de imputacion de esta pantalla (barra de dias y selector de mes). Si navegas a otro mes, estos numeros se recalculan para ese mes.',
        referenceMonthKeyLabel:
            'Clave mes-ano usada en el calculo (ano-mes): coincide con el mes activo en la interfaz.',
        calendarDays: lastDay,
        weekendCount,
        holidayRows,
        holidayCount: holidayRows.length,
        businessDays,
        jornada,
        pct,
        metaHoras,
        metaFacturable,
        metaHorasFormatted: formatHoursShortMeta(metaHoras),
        metaFacturableFormatted:
            metaFacturable != null ? formatHoursShortMeta(metaFacturable) : '\u2014',
        chartLogicKey,
        chartLogicLabel,
        holidayCatalogNote:
            'Festivos: lista fija Chile en codigo + festivos extra del objeto operativo (MM-DD). No incluye puentes ni moviles.',
        quarterNote:
            'Trimestre: si un mes no tiene desglose, la estimacion de facturable puede usar el mismo coeficiente sobre totales mensuales.',
        warnings,
        warningsReferenceTitle: 'Reglas y avisos activos (configuracion operativa)',
        holidayListLastReviewIso: CHILE_HOLIDAYS_LIST_LAST_REVIEW_ISO,
        holidayListLastReviewDisplay: formatMonitorPlainDateEs(CHILE_HOLIDAYS_LIST_LAST_REVIEW_ISO),
        policyLinks: MONITOR_POLICY_LINKS,
        internalPolicyNote:
            'Politica interna de la empresa (puentes, horas extra o criterios distintos a la ley): documentadla en vuestra wiki o intranet.'
    };
}

export function calcTransparencyHasWarnings(model) {
    return !!(model && Array.isArray(model.warnings) && model.warnings.length);
}
