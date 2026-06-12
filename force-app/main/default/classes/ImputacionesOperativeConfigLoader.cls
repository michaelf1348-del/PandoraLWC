/**

 * Lectura del registro operativo DEFAULT sin sharing (OWD suele restringir el objeto).

 * No usar isAccessible() antes del SOQL: consultores sin permiso CRUD en el objeto

 * deben igualmente recibir colores/meta en runtime (SYSTEM_MODE + without sharing).

 */

public without sharing class ImputacionesOperativeConfigLoader {

    private static final String CONFIG_KEY = 'DEFAULT';



    public static Configurar_Centro_Imputaciones__c loadDefault() {

        if (!Schema.getGlobalDescribe().containsKey('Configurar_Centro_Imputaciones__c')) {

            return null;

        }

        List<Configurar_Centro_Imputaciones__c> rows = queryOperativeRows(

            'WHERE Config_Key__c = :CONFIG_KEY',

            new Map<String, Object>{ 'CONFIG_KEY' => CONFIG_KEY }

        );

        if (!rows.isEmpty()) {

            return rows[0];

        }

        rows = queryOperativeRows('WHERE Name = :CONFIG_KEY', new Map<String, Object>{ 'CONFIG_KEY' => CONFIG_KEY });

        if (!rows.isEmpty()) {

            return rows[0];

        }

        rows = queryOperativeRows('ORDER BY LastModifiedDate DESC', null);

        return rows.isEmpty() ? null : rows[0];

    }



    private static List<Configurar_Centro_Imputaciones__c> queryOperativeRows(

        String whereAndOrder,

        Map<String, Object> binds

    ) {

        String soql =

            'SELECT Id, Name, Config_Key__c, PEP_Facturable__c, PEP_Fallback__c, Motivo_Ticket__c, ' +

            'Motivos_Fallback__c, Servicios__c, Servicios_Fallback__c, Dias_franja_calendario__c, ' +

            'Horas_Jornada__c, Numero_Ticket_Anclados__c, Tamano_Pagina_Tickets__c, Umbral_Aviso_Horas_Dia__c, ' +

            'Meta_Facturable_Pct__c, Origen_Imputacion__c, Horas_Meta_Dia_Lab__c, Ams_Creado_Filtro_Dias_Atras__c, ' +

            'Limite_Soql_Desglose_Dia__c, Limite_Soql_Mes_Agregacion__c, Limite_Soql_Owner_Opciones__c, ' +

            'Ayuda_Texto_General__c, Ui_Mostrar_Guia_Uso__c, Guia_Uso_Texto__c, Festivos_Extra_MM_DD__c, ' +

            'Imputacion_Meses_Retro__c, Imputacion_Meses_Adelante__c, Servicios_Ultimo_Recurso__c, ' +

            'Motivos_Ultimo_Recurso__c, Ui_Ocultar_Importar_Csv__c, Ui_Ocultar_Exportar_Csv__c, ' +

            'Ui_Ocultar_Panel_Trimestral__c, Ui_Ocultar_Tab_Gestion_Ams__c, Campo_Case_Motivo_Ams__c, ' +

            'Ayuda_Admin_Monitor__c, Color_Cal_Dia_Vacio_Fondo__c, Color_Cal_Dia_Parcial_Fondo__c, ' +

            'Color_Cal_Dia_Parcial_Borde__c, Color_Cal_Dia_Meta_Fondo__c, Color_Cal_Dia_Meta_Borde__c, ' +

            'Color_Cal_Dia_Sobre_Umbral__c, Color_Cal_Dia_Feriado_Fondo__c, Color_Cal_Dia_Fin_Semana_Fondo__c, ' +

            'Color_Cal_Dia_Seleccion_Fondo__c, Color_Cal_Dia_Seleccion_Borde__c, Color_Cal_Dia_Bloqueado_Fondo__c, ' +

            'Color_Grafico_Facturable__c, Color_Grafico_No_Facturable__c, Color_Grafico_Meta_Progreso__c, Color_Grafico_Imputable__c, ' +

            'Pestanas_Catalogo_Tickets__c, Permitir_Imputar_Fin_Semana__c, Permitir_Imputar_Feriados__c, ' +

            'Texto_Aviso_Fin_Semana__c, Texto_Aviso_Umbral_Horas__c, Texto_Aviso_Feriado__c, ' +

            'Texto_Confirmacion_Imputacion__c, Panel_Meta_Copy_JSON__c, Criterio_Calculo_Facturable__c, ' +

            'Criterio_Calculo_No_Facturable__c, Criterios_Facturable_Filtros_JSON__c, Texto_Subtitulo_Centro__c, ' +

            'Excepcion_Fin_Semana_User_Campo__c, Excepcion_Fin_Semana_User_Valores__c, Activar_Aviso_Umbral_Horas__c, ' +

            'Filtro_Servicio_Tickets__c, Filtro_Consultor_User_Campo__c, Filtro_Consultor_User_Valores__c ' +

            'FROM Configurar_Centro_Imputaciones__c ' +

            whereAndOrder +

            ' LIMIT 1';

        if (binds == null || binds.isEmpty()) {

            return Database.query(soql);

        }

        return Database.queryWithBinds(soql, binds, AccessLevel.SYSTEM_MODE);

    }



    public static String serializeThemeSettingsJson() {

        ImputacionesAMSController.ImputationCenterSettingsDTO dto = new ImputacionesAMSController.ImputationCenterSettingsDTO();

        applyThemeToSettingsDto(dto);

        Map<String, Object> theme = new Map<String, Object>();

        theme.put('chartColorFacturable', dto.chartColorFacturable);

        theme.put('chartColorNoFacturable', dto.chartColorNoFacturable);

        theme.put('chartColorMetaProgress', dto.chartColorMetaProgress);

        theme.put('chartColorImputable', dto.chartColorImputable);

        theme.put('calColorEmptyBg', dto.calColorEmptyBg);

        theme.put('calColorPartialBg', dto.calColorPartialBg);

        theme.put('calColorPartialBorder', dto.calColorPartialBorder);

        theme.put('calColorMetaBg', dto.calColorMetaBg);

        theme.put('calColorMetaBorder', dto.calColorMetaBorder);

        theme.put('calColorOverThreshold', dto.calColorOverThreshold);

        theme.put('calColorHolidayBg', dto.calColorHolidayBg);

        theme.put('calColorWeekendBg', dto.calColorWeekendBg);

        theme.put('calColorSelectedBg', dto.calColorSelectedBg);

        theme.put('calColorSelectedBorder', dto.calColorSelectedBorder);

        theme.put('calColorLockedBg', dto.calColorLockedBg);

        return JSON.serialize(theme);

    }



    public static void applyThemeToSettingsDto(ImputacionesAMSController.ImputationCenterSettingsDTO dto) {

        if (dto == null) {

            return;

        }

        Configurar_Centro_Imputaciones__c oc = loadDefault();

        dto.calColorEmptyBg = colorHex(oc, 'Color_Cal_Dia_Vacio_Fondo__c', '#F7F8FA');

        dto.calColorPartialBg = colorHex(oc, 'Color_Cal_Dia_Parcial_Fondo__c', '#FEF9EC');

        dto.calColorPartialBorder = colorHex(oc, 'Color_Cal_Dia_Parcial_Borde__c', '#E6DABE');

        dto.calColorMetaBg = colorHex(oc, 'Color_Cal_Dia_Meta_Fondo__c', '#EFF8F3');

        dto.calColorMetaBorder = colorHex(oc, 'Color_Cal_Dia_Meta_Borde__c', '#B8DCCB');

        dto.calColorOverThreshold = colorHex(oc, 'Color_Cal_Dia_Sobre_Umbral__c', '#EA580C');

        dto.calColorHolidayBg = colorHex(oc, 'Color_Cal_Dia_Feriado_Fondo__c', '#FFF1F3');

        dto.calColorWeekendBg = colorHex(oc, 'Color_Cal_Dia_Fin_Semana_Fondo__c', '#FEF6F8');

        dto.calColorSelectedBg = colorHex(oc, 'Color_Cal_Dia_Seleccion_Fondo__c', '#E9F4FF');

        dto.calColorSelectedBorder = colorHex(oc, 'Color_Cal_Dia_Seleccion_Borde__c', '#82A7CF');

        dto.calColorLockedBg = colorHex(oc, 'Color_Cal_Dia_Bloqueado_Fondo__c', '#EEF1F6');

        dto.chartColorFacturable = colorHex(oc, 'Color_Grafico_Facturable__c', '#15803D');

        dto.chartColorNoFacturable = colorHex(oc, 'Color_Grafico_No_Facturable__c', '#EA580C');

        dto.chartColorMetaProgress = colorHex(oc, 'Color_Grafico_Meta_Progreso__c', '#F59E0B');

        dto.chartColorImputable = colorHex(oc, 'Color_Grafico_Imputable__c', '#2563EB');

    }



    private static String colorHex(Configurar_Centro_Imputaciones__c oc, String fieldApi, String fallbackHex) {

        if (oc == null) {

            return fallbackHex;

        }

        Object v = oc.get(fieldApi);

        return normalizeHex(v == null ? null : String.valueOf(v), fallbackHex);

    }



    private static String normalizeHex(String raw, String fallbackHex) {

        if (String.isBlank(raw)) {

            return fallbackHex;

        }

        String t = raw.trim();

        if (t.startsWith('#')) {

            t = t.substring(1);

        }

        if (t.length() != 6 || !Pattern.matches('[0-9A-Fa-f]{6}', t)) {

            return fallbackHex;

        }

        return '#' + t.toUpperCase();

    }

}


