/** Puntos clave para consultores (modal Guia de uso). Textos con escapes Unicode para evitar corrupcion al desplegar. */
const CALENDAR_LEGEND_ITEMS = [
    {
        key: 'full',
        swatchClass: 'cal-legend-sample cal-legend-sample--success',
        label: '\u2248 d\u00EDa completo (\u2265 8 h)'
    },
    {
        key: 'partial',
        swatchClass: 'cal-legend-sample cal-legend-sample--partial',
        label: 'horas ese d\u00EDa pero < 8'
    },
    {
        key: 'active',
        swatchClass: 'cal-legend-sample cal-legend-sample--active',
        label: 'fecha enfocada / selecci\u00F3n multi'
    }
];

const DEFAULT_USAGE_POINTS = [
    {
        key: 'month',
        title: 'Mes y calendario',
        text:
            'Puedes cambiar de mes para consultar horas ya cargadas. Solo puedes registrar horas en el mes en curso, salvo que el centro te permita meses anteriores o posteriores.'
    },
    {
        key: 'colors',
        title: 'Colores del calendario',
        text:
            'Los colores del d\u00EDa dependen de las horas ya cargadas ese d\u00EDa y de la selecci\u00F3n:',
        legendItems: CALENDAR_LEGEND_ITEMS
    },
    {
        key: 'select',
        title: 'Seleccionar y guardar',
        text:
            'Marca los tickets en la tabla, escribe las horas y pulsa Confirmar imputaci\u00F3n. Revisa el resumen del di\u00E1logo antes de aceptar.'
    },
    {
        key: 'csv',
        title: 'Importar / exportar CSV',
        text:
            'Desde el men\u00FA CSV puedes exportar el mes visible o importar un archivo. Usa el n\u00FAmero de ticket completo tal como aparece en Pandora (por ejemplo 00017359).'
    },
    {
        key: 'closed',
        title: 'Tickets cerrados',
        text: 'No puedes crear imputaciones en tickets cerrados.'
    },
    {
        key: 'ams',
        title: 'Pesta\u00F1a Gesti\u00F3n AMS',
        text:
            'Lista tickets de gesti\u00F3n AMS. Las horas suelen registrarse como no facturables. Las vacaciones se consideran facturables.'
    }
];

/**
 * @param {{ usageGuideIntro?: string }} settings
 */
export function buildUsageGuideModel(settings = {}) {
    const introRaw = settings.usageGuideIntro && String(settings.usageGuideIntro).trim();
    const intro =
        introRaw ||
        'Gu\u00EDa r\u00E1pida para registrar y consultar tus horas en el centro de imputaciones.';
    return {
        intro,
        points: DEFAULT_USAGE_POINTS.map((p) => ({
            ...p,
            legendItems: p.legendItems ? p.legendItems.map((leg) => ({ ...leg })) : null
        }))
    };
}
