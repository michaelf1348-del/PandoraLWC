/**

 * LWC complementario: lectura y guardado del registro operativo

 * Configurar_Centro_Imputaciones__c (clave DEFAULT).

 * Solo usuarios con Admin_Imputacion__c = true.

 */

public with sharing class CentroImputacionesConfigController {

    private static final String CONFIG_KEY = 'DEFAULT';



    private static Boolean isImputationAdminUser() {

        Map<String, Schema.SObjectField> userFields = User.SObjectType.getDescribe().fields.getMap();

        if (!userFields.containsKey('Admin_Imputacion__c')) {

            return false;

        }

        User u = [SELECT Admin_Imputacion__c FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];

        return u.Admin_Imputacion__c == true;

    }



    public class CentroConfigViewDTO {

        @AuraEnabled public Boolean success;

        @AuraEnabled public String message;

        @AuraEnabled public String recordId;

        @AuraEnabled public String configKey;

        @AuraEnabled public String recordName;

        @AuraEnabled public String pepSiempreFacturables;

        @AuraEnabled public String pepFallback;

        @AuraEnabled public String motivosGestionAms;

        @AuraEnabled public String motivosFallback;

        @AuraEnabled public String serviciosAms;

        @AuraEnabled public String serviciosFallback;

        @AuraEnabled public Decimal maxTicketsAnclados;

        @AuraEnabled public Decimal diasFranjaCalendario;

        @AuraEnabled public Decimal umbralHorasDia;

        @AuraEnabled public Decimal umbralAvisoHorasDia;

        @AuraEnabled public Decimal tamanoPaginaTickets;

        @AuraEnabled public Decimal metaFacturablePct;

        @AuraEnabled public String origenImputacionDefault;

        @AuraEnabled public Decimal horasMetaDiaLab;

        @AuraEnabled public Decimal amsFiltroCreadoDiasAtras;

        @AuraEnabled public Decimal limiteSoqlDesgloseDia;

        @AuraEnabled public Decimal limiteSoqlMesAgregacion;

        @AuraEnabled public Decimal limiteSoqlOwnerOpciones;

        @AuraEnabled public String ayudaTextoGeneral;

        @AuraEnabled public Boolean uiMostrarGuiaUso;

        @AuraEnabled public String guiaUsoTexto;

        @AuraEnabled public String festivosExtraMmDd;

        @AuraEnabled public Decimal imputacionMesesRetro;

        @AuraEnabled public Decimal imputacionMesesAdelante;

        @AuraEnabled public String serviciosUltimoRecurso;

        @AuraEnabled public String motivosUltimoRecurso;

        @AuraEnabled public Boolean uiOcultarImportarCsv;

        @AuraEnabled public Boolean uiOcultarExportarCsv;

        @AuraEnabled public Boolean uiOcultarPanelTrimestral;

        @AuraEnabled public Boolean uiOcultarTabGestionAms;

        @AuraEnabled public String campoCaseMotivoAms;

        @AuraEnabled public String ayudaAdminMonitor;

        @AuraEnabled public String colorCalDiaVacioFondo;

        @AuraEnabled public String colorCalDiaParcialFondo;

        @AuraEnabled public String colorCalDiaParcialBorde;

        @AuraEnabled public String colorCalDiaMetaFondo;

        @AuraEnabled public String colorCalDiaMetaBorde;

        @AuraEnabled public String colorCalDiaSobreUmbral;

        @AuraEnabled public String colorCalDiaFeriadoFondo;

        @AuraEnabled public String colorCalDiaFinSemanaFondo;

        @AuraEnabled public String colorCalDiaSeleccionFondo;

        @AuraEnabled public String colorCalDiaSeleccionBorde;

        @AuraEnabled public String colorCalDiaBloqueadoFondo;

        @AuraEnabled public String colorGraficoFacturable;

        @AuraEnabled public String colorGraficoNoFacturable;

        @AuraEnabled public String colorGraficoMetaProgreso;

        @AuraEnabled public String colorGraficoImputable;

        @AuraEnabled public String diagnosticsJson;

        @AuraEnabled public String pestanasCatalogoTickets;

        @AuraEnabled public Boolean permitirImputarFinSemana;

        @AuraEnabled public Boolean permitirImputarFeriados;

        @AuraEnabled public String textoAvisoFinSemana;

        @AuraEnabled public String textoAvisoUmbralHoras;

        @AuraEnabled public String textoAvisoFeriado;

        @AuraEnabled public String textoConfirmacionImputacion;

        @AuraEnabled public String panelMetaCopyJson;

        @AuraEnabled public String criterioCalculoFacturable;

        @AuraEnabled public String criterioCalculoNoFacturable;

        @AuraEnabled public String textoSubtituloCentro;

        @AuraEnabled public String excepcionFinSemanaUserCampo;

        @AuraEnabled public String excepcionFinSemanaUserValores;

        @AuraEnabled public Boolean activarAvisoUmbralHoras;

        @AuraEnabled public String filtroServicioTickets;

        @AuraEnabled public String filtroConsultorUserCampo;

        @AuraEnabled public String filtroConsultorUserValores;

        @AuraEnabled public String criteriosFacturableFiltrosJson;

    }



    /** Entrada JSON para guardar (sin success/message). */

    public class SaveCentroConfigInput {

        public String recordId;

        public String recordName;

        public String pepSiempreFacturables;

        public String pepFallback;

        public String motivosGestionAms;

        public String motivosFallback;

        public String serviciosAms;

        public String serviciosFallback;

        public Decimal maxTicketsAnclados;

        public Decimal diasFranjaCalendario;

        public Decimal umbralHorasDia;

        public Decimal umbralAvisoHorasDia;

        public Decimal tamanoPaginaTickets;

        public Decimal metaFacturablePct;

        public String origenImputacionDefault;

        public Decimal horasMetaDiaLab;

        public Decimal amsFiltroCreadoDiasAtras;

        public Decimal limiteSoqlDesgloseDia;

        public Decimal limiteSoqlMesAgregacion;

        public Decimal limiteSoqlOwnerOpciones;

        public String ayudaTextoGeneral;

        public Boolean uiMostrarGuiaUso;

        public String guiaUsoTexto;

        public String festivosExtraMmDd;

        public Decimal imputacionMesesRetro;

        public Decimal imputacionMesesAdelante;

        public String serviciosUltimoRecurso;

        public String motivosUltimoRecurso;

        public Boolean uiOcultarImportarCsv;

        public Boolean uiOcultarExportarCsv;

        public Boolean uiOcultarPanelTrimestral;

        public Boolean uiOcultarTabGestionAms;

        public String campoCaseMotivoAms;

        public String ayudaAdminMonitor;

        public String colorCalDiaVacioFondo;

        public String colorCalDiaParcialFondo;

        public String colorCalDiaParcialBorde;

        public String colorCalDiaMetaFondo;

        public String colorCalDiaMetaBorde;

        public String colorCalDiaSobreUmbral;

        public String colorCalDiaFeriadoFondo;

        public String colorCalDiaFinSemanaFondo;

        public String colorCalDiaSeleccionFondo;

        public String colorCalDiaSeleccionBorde;

        public String colorCalDiaBloqueadoFondo;

        public String colorGraficoFacturable;

        public String colorGraficoNoFacturable;

        public String colorGraficoMetaProgreso;

        public String colorGraficoImputable;

        public String pestanasCatalogoTickets;

        public Boolean permitirImputarFinSemana;

        public Boolean permitirImputarFeriados;

        public String textoAvisoFinSemana;

        public String textoAvisoUmbralHoras;

        public String textoAvisoFeriado;

        public String textoConfirmacionImputacion;

        public String panelMetaCopyJson;

        public String criterioCalculoFacturable;

        public String criterioCalculoNoFacturable;

        public String textoSubtituloCentro;

        public String excepcionFinSemanaUserCampo;

        public String excepcionFinSemanaUserValores;

        public Boolean activarAvisoUmbralHoras;

        public String filtroServicioTickets;

        public String filtroConsultorUserCampo;

        public String filtroConsultorUserValores;

        public String criteriosFacturableFiltrosJson;

    }



    @AuraEnabled(cacheable=false)

    public static String loadCentroConfig() {

        CentroConfigViewDTO out = new CentroConfigViewDTO();

        out.success = false;

        out.message = '';

        if (!isImputationAdminUser()) {

            out.message = 'Solo los administradores de imputacion pueden ver esta pantalla.';

            return JSON.serialize(out);

        }

        try {

            if (!Schema.getGlobalDescribe().containsKey('Configurar_Centro_Imputaciones__c')) {

                out.message = 'Falta el objeto Configurar_Centro_Imputaciones__c en esta org.';

                return JSON.serialize(out);

            }

            if (!Configurar_Centro_Imputaciones__c.SObjectType.getDescribe().isAccessible()) {

                out.message = 'Sin permiso de lectura sobre la configuracion operativa.';

                return JSON.serialize(out);

            }

            List<Configurar_Centro_Imputaciones__c> rows = [

                SELECT

                    Id,

                    Name,

                    Config_Key__c,

                    PEP_Facturable__c,

                    PEP_Fallback__c,

                    Motivo_Ticket__c,

                    Motivos_Fallback__c,

                    Servicios__c,

                    Servicios_Fallback__c,

                    Numero_Ticket_Anclados__c,

                    Dias_franja_calendario__c,

                    Horas_Jornada__c,

                    Umbral_Aviso_Horas_Dia__c,

                    Tamano_Pagina_Tickets__c,

                    Meta_Facturable_Pct__c,

                    Origen_Imputacion__c,

                    Horas_Meta_Dia_Lab__c,

                    Ams_Creado_Filtro_Dias_Atras__c,

                    Limite_Soql_Desglose_Dia__c,

                    Limite_Soql_Mes_Agregacion__c,

                    Limite_Soql_Owner_Opciones__c,

                    Ayuda_Texto_General__c,

                    Ui_Mostrar_Guia_Uso__c,

                    Guia_Uso_Texto__c,

                    Festivos_Extra_MM_DD__c,

                    Imputacion_Meses_Retro__c,

                    Imputacion_Meses_Adelante__c,

                    Servicios_Ultimo_Recurso__c,

                    Motivos_Ultimo_Recurso__c,

                    Ui_Ocultar_Importar_Csv__c,

                    Ui_Ocultar_Exportar_Csv__c,

                    Ui_Ocultar_Panel_Trimestral__c,

                    Ui_Ocultar_Tab_Gestion_Ams__c,

                    Campo_Case_Motivo_Ams__c,

                    Ayuda_Admin_Monitor__c,

                    Color_Cal_Dia_Vacio_Fondo__c,

                    Color_Cal_Dia_Parcial_Fondo__c,

                    Color_Cal_Dia_Parcial_Borde__c,

                    Color_Cal_Dia_Meta_Fondo__c,

                    Color_Cal_Dia_Meta_Borde__c,

                    Color_Cal_Dia_Sobre_Umbral__c,

                    Color_Cal_Dia_Feriado_Fondo__c,

                    Color_Cal_Dia_Fin_Semana_Fondo__c,

                    Color_Cal_Dia_Seleccion_Fondo__c,

                    Color_Cal_Dia_Seleccion_Borde__c,

                    Color_Cal_Dia_Bloqueado_Fondo__c,
                    Color_Grafico_Facturable__c,
                    Color_Grafico_No_Facturable__c,
                    Color_Grafico_Meta_Progreso__c,
                    Color_Grafico_Imputable__c,

                    Pestanas_Catalogo_Tickets__c,

                    Permitir_Imputar_Fin_Semana__c,

                    Permitir_Imputar_Feriados__c,

                    Texto_Aviso_Fin_Semana__c,

                    Texto_Aviso_Umbral_Horas__c,

                    Texto_Aviso_Feriado__c,

                    Texto_Confirmacion_Imputacion__c,

                    Panel_Meta_Copy_JSON__c,

                    Criterio_Calculo_Facturable__c,

                    Criterio_Calculo_No_Facturable__c,

                    Texto_Subtitulo_Centro__c,

                    Excepcion_Fin_Semana_User_Campo__c,

                    Excepcion_Fin_Semana_User_Valores__c,

                    Activar_Aviso_Umbral_Horas__c,

                    Filtro_Servicio_Tickets__c,

                    Filtro_Consultor_User_Campo__c,

                    Filtro_Consultor_User_Valores__c,

                    Criterios_Facturable_Filtros_JSON__c

                FROM Configurar_Centro_Imputaciones__c

                WHERE Config_Key__c = :CONFIG_KEY

                LIMIT 1

            ];

            out.success = true;

            if (rows.isEmpty()) {

                out.configKey = CONFIG_KEY;

                out.recordName = CONFIG_KEY;

                out.message = 'No hay registro todavia. Completa los campos y guarda para crear DEFAULT.';

                return JSON.serialize(out);

            }

            Configurar_Centro_Imputaciones__c r = rows[0];

            out.recordId = r.Id;

            out.configKey = r.Config_Key__c;

            out.recordName = r.Name;

            out.pepSiempreFacturables = r.PEP_Facturable__c;

            out.pepFallback = r.PEP_Fallback__c;

            out.motivosGestionAms = r.Motivo_Ticket__c;

            out.motivosFallback = r.Motivos_Fallback__c;

            out.serviciosAms = r.Servicios__c;

            out.serviciosFallback = r.Servicios_Fallback__c;

            out.maxTicketsAnclados = r.Numero_Ticket_Anclados__c;

            out.diasFranjaCalendario = r.Dias_franja_calendario__c;

            out.umbralHorasDia = r.Horas_Jornada__c;

            out.umbralAvisoHorasDia = r.Umbral_Aviso_Horas_Dia__c;

            out.tamanoPaginaTickets = r.Tamano_Pagina_Tickets__c;

            out.metaFacturablePct = r.Meta_Facturable_Pct__c;

            out.origenImputacionDefault = r.Origen_Imputacion__c;

            out.horasMetaDiaLab = r.Horas_Meta_Dia_Lab__c;

            out.amsFiltroCreadoDiasAtras = r.Ams_Creado_Filtro_Dias_Atras__c;

            out.limiteSoqlDesgloseDia = r.Limite_Soql_Desglose_Dia__c;

            out.limiteSoqlMesAgregacion = r.Limite_Soql_Mes_Agregacion__c;

            out.limiteSoqlOwnerOpciones = r.Limite_Soql_Owner_Opciones__c;

            out.ayudaTextoGeneral = r.Ayuda_Texto_General__c;

            out.uiMostrarGuiaUso = r.Ui_Mostrar_Guia_Uso__c != false;

            out.guiaUsoTexto = r.Guia_Uso_Texto__c;

            out.festivosExtraMmDd = r.Festivos_Extra_MM_DD__c;

            out.imputacionMesesRetro = r.Imputacion_Meses_Retro__c;

            out.imputacionMesesAdelante = r.Imputacion_Meses_Adelante__c;

            out.serviciosUltimoRecurso = r.Servicios_Ultimo_Recurso__c;

            out.motivosUltimoRecurso = r.Motivos_Ultimo_Recurso__c;

            out.uiOcultarImportarCsv = r.Ui_Ocultar_Importar_Csv__c == true;

            out.uiOcultarExportarCsv = r.Ui_Ocultar_Exportar_Csv__c == true;

            out.uiOcultarPanelTrimestral = r.Ui_Ocultar_Panel_Trimestral__c == true;

            out.uiOcultarTabGestionAms = r.Ui_Ocultar_Tab_Gestion_Ams__c == true;

            out.campoCaseMotivoAms = r.Campo_Case_Motivo_Ams__c;

            out.ayudaAdminMonitor = r.Ayuda_Admin_Monitor__c;

            out.colorCalDiaVacioFondo = r.Color_Cal_Dia_Vacio_Fondo__c;

            out.colorCalDiaParcialFondo = r.Color_Cal_Dia_Parcial_Fondo__c;

            out.colorCalDiaParcialBorde = r.Color_Cal_Dia_Parcial_Borde__c;

            out.colorCalDiaMetaFondo = r.Color_Cal_Dia_Meta_Fondo__c;

            out.colorCalDiaMetaBorde = r.Color_Cal_Dia_Meta_Borde__c;

            out.colorCalDiaSobreUmbral = r.Color_Cal_Dia_Sobre_Umbral__c;

            out.colorCalDiaFeriadoFondo = r.Color_Cal_Dia_Feriado_Fondo__c;

            out.colorCalDiaFinSemanaFondo = r.Color_Cal_Dia_Fin_Semana_Fondo__c;

            out.colorCalDiaSeleccionFondo = r.Color_Cal_Dia_Seleccion_Fondo__c;

            out.colorCalDiaSeleccionBorde = r.Color_Cal_Dia_Seleccion_Borde__c;

            out.colorCalDiaBloqueadoFondo = r.Color_Cal_Dia_Bloqueado_Fondo__c;

            out.colorGraficoFacturable = r.Color_Grafico_Facturable__c;

            out.colorGraficoNoFacturable = r.Color_Grafico_No_Facturable__c;

            out.colorGraficoMetaProgreso = r.Color_Grafico_Meta_Progreso__c;

            out.colorGraficoImputable = r.Color_Grafico_Imputable__c;

            out.pestanasCatalogoTickets = r.Pestanas_Catalogo_Tickets__c;

            out.permitirImputarFinSemana = r.Permitir_Imputar_Fin_Semana__c != false;

            out.permitirImputarFeriados = r.Permitir_Imputar_Feriados__c != false;

            out.textoAvisoFinSemana = r.Texto_Aviso_Fin_Semana__c;

            out.textoAvisoUmbralHoras = r.Texto_Aviso_Umbral_Horas__c;

            out.textoAvisoFeriado = r.Texto_Aviso_Feriado__c;

            out.textoConfirmacionImputacion = r.Texto_Confirmacion_Imputacion__c;

            out.panelMetaCopyJson = r.Panel_Meta_Copy_JSON__c;

            out.criterioCalculoFacturable = r.Criterio_Calculo_Facturable__c;

            out.criterioCalculoNoFacturable = r.Criterio_Calculo_No_Facturable__c;

            out.textoSubtituloCentro = r.Texto_Subtitulo_Centro__c;

            out.excepcionFinSemanaUserCampo = r.Excepcion_Fin_Semana_User_Campo__c;
            out.excepcionFinSemanaUserValores = r.Excepcion_Fin_Semana_User_Valores__c;
            out.activarAvisoUmbralHoras = r.Activar_Aviso_Umbral_Horas__c != false;
            out.filtroServicioTickets = r.Filtro_Servicio_Tickets__c;
            out.filtroConsultorUserCampo = r.Filtro_Consultor_User_Campo__c;
            out.filtroConsultorUserValores = r.Filtro_Consultor_User_Valores__c;

            out.criteriosFacturableFiltrosJson = r.Criterios_Facturable_Filtros_JSON__c;

            try {

                out.diagnosticsJson = ImputacionesAMSController.getImputationCenterDiagnostics();

            } catch (Exception diagEx) {

                out.diagnosticsJson = '[]';

            }

        } catch (Exception e) {

            out.message = e.getMessage();

        }

        return JSON.serialize(out);

    }



    @AuraEnabled

    public static String saveCentroConfig(String payloadJson) {

        CentroConfigViewDTO resp = new CentroConfigViewDTO();

        resp.success = false;

        if (!isImputationAdminUser()) {

            resp.message = 'Solo los administradores de imputacion pueden guardar.';

            return JSON.serialize(resp);

        }

        SaveCentroConfigInput p;

        try {

            p = (SaveCentroConfigInput) JSON.deserialize(payloadJson, SaveCentroConfigInput.class);

        } catch (Exception e) {

            resp.message = 'Datos invalidos.';

            return JSON.serialize(resp);

        }

        if (p == null) {

            resp.message = 'Payload vacio.';

            return JSON.serialize(resp);

        }

        try {

            if (!Schema.getGlobalDescribe().containsKey('Configurar_Centro_Imputaciones__c')) {

                resp.message = 'Falta el objeto Configurar_Centro_Imputaciones__c.';

                return JSON.serialize(resp);

            }

            if (

                !Configurar_Centro_Imputaciones__c.SObjectType.getDescribe().isCreateable() &&

                !Configurar_Centro_Imputaciones__c.SObjectType.getDescribe().isUpdateable()

            ) {

                resp.message = 'Sin permiso para crear o actualizar la configuracion.';

                return JSON.serialize(resp);

            }



            Configurar_Centro_Imputaciones__c recToSave;

            List<Configurar_Centro_Imputaciones__c> existing = [

                SELECT Id

                FROM Configurar_Centro_Imputaciones__c

                WHERE Config_Key__c = :CONFIG_KEY

                LIMIT 1

            ];

            if (!existing.isEmpty()) {

                recToSave = new Configurar_Centro_Imputaciones__c(Id = existing[0].Id);

            } else {

                String nm =

                    String.isNotBlank(p.recordName) ? p.recordName.trim().left(80) : CONFIG_KEY;

                recToSave = new Configurar_Centro_Imputaciones__c(Config_Key__c = CONFIG_KEY, Name = nm);

            }



            recToSave.PEP_Facturable__c = p.pepSiempreFacturables;

            recToSave.PEP_Fallback__c = p.pepFallback;

            recToSave.Motivo_Ticket__c = p.motivosGestionAms;

            recToSave.Motivos_Fallback__c = p.motivosFallback;

            recToSave.Servicios__c = p.serviciosAms;

            recToSave.Servicios_Fallback__c = p.serviciosFallback;

            recToSave.Numero_Ticket_Anclados__c = p.maxTicketsAnclados;

            recToSave.Dias_franja_calendario__c = p.diasFranjaCalendario;

            recToSave.Horas_Jornada__c = p.umbralHorasDia;

            recToSave.Umbral_Aviso_Horas_Dia__c = p.umbralAvisoHorasDia;

            recToSave.Tamano_Pagina_Tickets__c = p.tamanoPaginaTickets;

            recToSave.Meta_Facturable_Pct__c = p.metaFacturablePct;

            recToSave.Origen_Imputacion__c =

                p.origenImputacionDefault == null ? null : p.origenImputacionDefault.trim().left(80);

            recToSave.Horas_Meta_Dia_Lab__c = p.horasMetaDiaLab;

            recToSave.Ams_Creado_Filtro_Dias_Atras__c = p.amsFiltroCreadoDiasAtras;

            recToSave.Limite_Soql_Desglose_Dia__c = p.limiteSoqlDesgloseDia;

            recToSave.Limite_Soql_Mes_Agregacion__c = p.limiteSoqlMesAgregacion;

            recToSave.Limite_Soql_Owner_Opciones__c = p.limiteSoqlOwnerOpciones;

            recToSave.Ayuda_Texto_General__c = p.ayudaTextoGeneral;

            recToSave.Ui_Mostrar_Guia_Uso__c = p.uiMostrarGuiaUso != false;

            recToSave.Guia_Uso_Texto__c = p.guiaUsoTexto;

            recToSave.Festivos_Extra_MM_DD__c = p.festivosExtraMmDd;

            recToSave.Imputacion_Meses_Retro__c = p.imputacionMesesRetro;

            recToSave.Imputacion_Meses_Adelante__c = p.imputacionMesesAdelante;

            recToSave.Servicios_Ultimo_Recurso__c = p.serviciosUltimoRecurso;

            recToSave.Motivos_Ultimo_Recurso__c = p.motivosUltimoRecurso;

            recToSave.Ui_Ocultar_Importar_Csv__c = p.uiOcultarImportarCsv == true;

            recToSave.Ui_Ocultar_Exportar_Csv__c = p.uiOcultarExportarCsv == true;

            recToSave.Ui_Ocultar_Panel_Trimestral__c = p.uiOcultarPanelTrimestral == true;

            recToSave.Ui_Ocultar_Tab_Gestion_Ams__c = p.uiOcultarTabGestionAms == true;

            recToSave.Campo_Case_Motivo_Ams__c =

                p.campoCaseMotivoAms == null ? null : p.campoCaseMotivoAms.trim().left(80);

            recToSave.Ayuda_Admin_Monitor__c = p.ayudaAdminMonitor;

            recToSave.Color_Cal_Dia_Vacio_Fondo__c = p.colorCalDiaVacioFondo;

            recToSave.Color_Cal_Dia_Parcial_Fondo__c = p.colorCalDiaParcialFondo;

            recToSave.Color_Cal_Dia_Parcial_Borde__c = p.colorCalDiaParcialBorde;

            recToSave.Color_Cal_Dia_Meta_Fondo__c = p.colorCalDiaMetaFondo;

            recToSave.Color_Cal_Dia_Meta_Borde__c = p.colorCalDiaMetaBorde;

            recToSave.Color_Cal_Dia_Sobre_Umbral__c = p.colorCalDiaSobreUmbral;

            recToSave.Color_Cal_Dia_Feriado_Fondo__c = p.colorCalDiaFeriadoFondo;

            recToSave.Color_Cal_Dia_Fin_Semana_Fondo__c = p.colorCalDiaFinSemanaFondo;

            recToSave.Color_Cal_Dia_Seleccion_Fondo__c = p.colorCalDiaSeleccionFondo;

            recToSave.Color_Cal_Dia_Seleccion_Borde__c = p.colorCalDiaSeleccionBorde;

            recToSave.Color_Cal_Dia_Bloqueado_Fondo__c = p.colorCalDiaBloqueadoFondo;

            recToSave.Color_Grafico_Facturable__c = p.colorGraficoFacturable;

            recToSave.Color_Grafico_No_Facturable__c = p.colorGraficoNoFacturable;

            recToSave.Color_Grafico_Meta_Progreso__c = p.colorGraficoMetaProgreso;

            recToSave.Color_Grafico_Imputable__c = p.colorGraficoImputable;

            recToSave.Pestanas_Catalogo_Tickets__c = p.pestanasCatalogoTickets;

            recToSave.Permitir_Imputar_Fin_Semana__c = p.permitirImputarFinSemana != false;

            recToSave.Permitir_Imputar_Feriados__c = p.permitirImputarFeriados != false;

            recToSave.Texto_Aviso_Fin_Semana__c = p.textoAvisoFinSemana;

            recToSave.Texto_Aviso_Umbral_Horas__c = p.textoAvisoUmbralHoras;

            recToSave.Texto_Aviso_Feriado__c = p.textoAvisoFeriado;

            recToSave.Texto_Confirmacion_Imputacion__c = p.textoConfirmacionImputacion;

            recToSave.Panel_Meta_Copy_JSON__c = p.panelMetaCopyJson;

            recToSave.Criterio_Calculo_Facturable__c = p.criterioCalculoFacturable;

            recToSave.Criterio_Calculo_No_Facturable__c = p.criterioCalculoNoFacturable;

            recToSave.Texto_Subtitulo_Centro__c = p.textoSubtituloCentro;

            recToSave.Excepcion_Fin_Semana_User_Campo__c =
                p.excepcionFinSemanaUserCampo == null ? null : p.excepcionFinSemanaUserCampo.trim().left(80);
            recToSave.Excepcion_Fin_Semana_User_Valores__c = p.excepcionFinSemanaUserValores;
            recToSave.Activar_Aviso_Umbral_Horas__c = p.activarAvisoUmbralHoras != false;
            recToSave.Filtro_Servicio_Tickets__c = p.filtroServicioTickets;
            recToSave.Filtro_Consultor_User_Campo__c =
                p.filtroConsultorUserCampo == null ? null : p.filtroConsultorUserCampo.trim().left(80);
            recToSave.Filtro_Consultor_User_Valores__c = p.filtroConsultorUserValores;

            recToSave.Criterios_Facturable_Filtros_JSON__c = p.criteriosFacturableFiltrosJson;

            if (String.isNotBlank(p.recordName)) {

                recToSave.Name = p.recordName.trim().left(80);

            }

            if (recToSave.Id != null) {

                update recToSave;

            } else {

                insert recToSave;

            }

            ImputacionesAMSController.clearOperativeConfigCache();

            resp.success = true;

            resp.recordId = recToSave.Id;

            resp.message = 'Configuracion guardada. El centro de imputaciones usara estos valores en las siguientes operaciones.';

        } catch (Exception e) {

            resp.message = e.getMessage();

        }

        return JSON.serialize(resp);

    }

}

