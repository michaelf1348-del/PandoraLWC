/** Colores por defecto del centro (graficos y meta). */
export const CHART_COLOR_DEFAULTS = {
    fact: '#21A366',
    noFact: '#EA580C',
    meta: '#F59E0B',
    imputable: '#3B82C4'
};

/** Normaliza hex para estilos inline y conic-gradient en LWC. */
export function normalizeThemeHex(raw, fallback) {
    const fb = fallback || CHART_COLOR_DEFAULTS.fact;
    if (raw == null || raw === '') {
        return fb;
    }
    let t = String(raw).trim();
    if (!t) {
        return fb;
    }
    if (!t.startsWith('#')) {
        t = `#${t}`;
    }
    let h = t.slice(1);
    if (h.length === 3) {
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
        t = `#${h}`;
    }
    t = t.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(t)) {
        return fb;
    }
    return t;
}

export function resolveChartColorsFromSettings(settings) {
    const s = settings || {};
    return {
        fact: normalizeThemeHex(s.chartColorFacturable, CHART_COLOR_DEFAULTS.fact),
        noFact: normalizeThemeHex(s.chartColorNoFacturable, CHART_COLOR_DEFAULTS.noFact),
        meta: normalizeThemeHex(s.chartColorMetaProgress, CHART_COLOR_DEFAULTS.meta),
        imputable: normalizeThemeHex(s.chartColorImputable, CHART_COLOR_DEFAULTS.imputable)
    };
}

/** Mismos defaults que la pantalla de configuracion (si Apex no devuelve color por FLS). */
export const CAL_COLOR_DEFAULTS = {
    calColorEmptyBg: '#FAFAFA',
    calColorPartialBg: '#FCF8EE',
    calColorPartialBorder: '#ECE2C8',
    calColorMetaBg: '#F1F8F4',
    calColorMetaBorder: '#CFE6D8',
    calColorOverThreshold: '#EA580C',
    calColorHolidayBg: '#FBF4F5',
    calColorWeekendBg: '#FAFAFA',
    calColorSelectedBg: '#EAF3FB',
    calColorSelectedBorder: '#9CBFE0',
    calColorLockedBg: '#F1F2F5'
};

/** Fusiona settings del Apex con defaults de tema (por si algun campo color viene null). */
export function coerceOperativeThemeSettings(settings) {
    const s = settings && typeof settings === 'object' ? { ...settings } : {};
    const chart = resolveChartColorsFromSettings(s);
    s.chartColorFacturable = chart.fact;
    s.chartColorNoFacturable = chart.noFact;
    s.chartColorMetaProgress = chart.meta;
    s.chartColorImputable = chart.imputable;
    s.calColorEmptyBg = normalizeThemeHex(s.calColorEmptyBg, CAL_COLOR_DEFAULTS.calColorEmptyBg);
    s.calColorPartialBg = normalizeThemeHex(s.calColorPartialBg, CAL_COLOR_DEFAULTS.calColorPartialBg);
    s.calColorPartialBorder = normalizeThemeHex(
        s.calColorPartialBorder,
        CAL_COLOR_DEFAULTS.calColorPartialBorder
    );
    s.calColorMetaBg = normalizeThemeHex(s.calColorMetaBg, CAL_COLOR_DEFAULTS.calColorMetaBg);
    s.calColorMetaBorder = normalizeThemeHex(s.calColorMetaBorder, CAL_COLOR_DEFAULTS.calColorMetaBorder);
    s.calColorOverThreshold = normalizeThemeHex(
        s.calColorOverThreshold,
        CAL_COLOR_DEFAULTS.calColorOverThreshold
    );
    s.calColorHolidayBg = normalizeThemeHex(s.calColorHolidayBg, CAL_COLOR_DEFAULTS.calColorHolidayBg);
    s.calColorWeekendBg = normalizeThemeHex(s.calColorWeekendBg, CAL_COLOR_DEFAULTS.calColorWeekendBg);
    s.calColorSelectedBg = normalizeThemeHex(s.calColorSelectedBg, CAL_COLOR_DEFAULTS.calColorSelectedBg);
    s.calColorSelectedBorder = normalizeThemeHex(
        s.calColorSelectedBorder,
        CAL_COLOR_DEFAULTS.calColorSelectedBorder
    );
    s.calColorLockedBg = normalizeThemeHex(s.calColorLockedBg, CAL_COLOR_DEFAULTS.calColorLockedBg);
    return s;
}

/**
 * Estilos inline en botones de franja/calendario (var() en LWC a veces no pinta).
 */
export function buildStripDayButtonInlineStyle(day, settings) {
    const s = coerceOperativeThemeSettings(settings);
    const parts = [];
    if (day?.disabled) {
        parts.push(`background:${s.calColorLockedBg}`, `border-color:${s.calColorLockedBg}`);
        parts.push('opacity:0.42');
        return parts.join(';');
    }
    if (day?.selected) {
        parts.push(`background:${s.calColorSelectedBg}`, `border-color:${s.calColorSelectedBorder}`, 'color:oklch(0.21 0.02 257)');
        return parts.join(';');
    }
    const cls = String(day?.buttonClass || '');
    if (cls.includes('strip-load--full')) {
        parts.push(`background:${s.calColorMetaBg}`, `border-color:${s.calColorMetaBorder}`);
    } else if (cls.includes('strip-load--partial')) {
        parts.push(`background:${s.calColorPartialBg}`, `border-color:${s.calColorPartialBorder}`);
    } else if (cls.includes('strip-day--holiday')) {
        parts.push(`background:${s.calColorHolidayBg}`, 'border-color:oklch(0.925 0.006 250)', 'color:oklch(0.55 0.015 257)');
    } else if (cls.includes('strip-day--weekend')) {
        parts.push(`background:${s.calColorWeekendBg}`, 'border-color:oklch(0.925 0.006 250)', 'color:oklch(0.55 0.015 257)');
    } else {
        parts.push(`background:${s.calColorEmptyBg}`, 'border-color:oklch(0.925 0.006 250)');
    }
    if (cls.includes('strip-day--over8h')) {
        const rgb = hexToRgbParts(s.calColorOverThreshold);
        if (rgb) {
            parts.push(`outline:1px solid rgba(${rgb.r},${rgb.g},${rgb.b},0.38)`);
        }
    }
    return parts.join(';');
}

/** Estilos inline para botones del calendario lateral (misma paleta que la franja). */
export function buildCalDayButtonInlineStyle(day, settings) {
    const s = coerceOperativeThemeSettings(settings);
    const cls = String(day?.buttonClass || '');
    const parts = [];
    if (day?.disabled) {
        parts.push(`background:${s.calColorLockedBg}`, 'opacity:0.42');
        return parts.join(';');
    }
    if (cls.includes(' active')) {
        parts.push(`background:${s.calColorSelectedBg}`, `border-color:${s.calColorSelectedBorder}`, 'color:oklch(0.21 0.02 257)');
        return parts.join(';');
    }
    if (cls.includes('goal-met')) {
        parts.push(`background:${s.calColorMetaBg}`, `border-color:${s.calColorMetaBorder}`, 'color:#ffffff');
        return parts.join(';');
    }
    if (cls.includes('partial-day')) {
        parts.push(`background:${s.calColorPartialBg}`, `border-color:${s.calColorPartialBorder}`);
        return parts.join(';');
    }
    if (cls.includes('holiday-day')) {
        parts.push(`background:${s.calColorHolidayBg}`, 'border-color:oklch(0.925 0.006 250)', 'color:oklch(0.55 0.015 257)');
        return parts.join(';');
    }
    if (cls.includes('weekend-day')) {
        parts.push(`background:${s.calColorWeekendBg}`, 'border-color:oklch(0.925 0.006 250)', 'color:oklch(0.55 0.015 257)');
        return parts.join(';');
    }
    parts.push(`background:${s.calColorEmptyBg}`, 'border-color:oklch(0.925 0.006 250)');
    if (cls.includes('cal-day--over8h')) {
        const rgb = hexToRgbParts(s.calColorOverThreshold);
        if (rgb) {
            parts.push(`outline:1px solid rgba(${rgb.r},${rgb.g},${rgb.b},0.38)`);
        }
    }
    return parts.join(';');
}

function hexToRgbParts(hex) {
    const h = normalizeThemeHex(hex, '#EA580C').replace('#', '');
    if (h.length !== 6) {
        return null;
    }
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

export function resolveCalendarCssVarsFromSettings(settings) {
    const s = settings || {};
    const chart = resolveChartColorsFromSettings(s);
    return {
        '--cc-cal-empty-bg': normalizeThemeHex(s.calColorEmptyBg, CAL_COLOR_DEFAULTS.calColorEmptyBg),
        '--cc-cal-partial-bg': normalizeThemeHex(s.calColorPartialBg, CAL_COLOR_DEFAULTS.calColorPartialBg),
        '--cc-cal-partial-border': normalizeThemeHex(
            s.calColorPartialBorder,
            CAL_COLOR_DEFAULTS.calColorPartialBorder
        ),
        '--cc-cal-meta-bg': normalizeThemeHex(s.calColorMetaBg, CAL_COLOR_DEFAULTS.calColorMetaBg),
        '--cc-cal-meta-border': normalizeThemeHex(s.calColorMetaBorder, CAL_COLOR_DEFAULTS.calColorMetaBorder),
        // Fin de semana y festivo: gris neutro fijo (look del prototipo Next.js).
        // Se ignora el valor guardado en la org para evitar los tintes rosados
        // (#FEF6F8 / #FFF1F3) que rompian la estetica limpia del calendario.
        '--cc-cal-holiday-bg': '#F4F5F7',
        '--cc-cal-weekend-bg': '#F4F5F7',
        '--cc-cal-selected-bg': normalizeThemeHex(s.calColorSelectedBg, CAL_COLOR_DEFAULTS.calColorSelectedBg),
        '--cc-cal-selected-border': normalizeThemeHex(
            s.calColorSelectedBorder,
            CAL_COLOR_DEFAULTS.calColorSelectedBorder
        ),
        '--cc-cal-locked-bg': normalizeThemeHex(s.calColorLockedBg, CAL_COLOR_DEFAULTS.calColorLockedBg),
        '--cc-chart-fact': chart.fact,
        '--cc-chart-nofact': chart.noFact,
        '--cc-chart-meta': chart.meta,
        '--cc-chart-imputable': chart.imputable
    };
}
