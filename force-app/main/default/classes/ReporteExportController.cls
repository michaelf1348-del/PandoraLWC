/**
 * @deprecated DEPRECATED desde Fase 3 de Pandora (2026).
 * Esta clase NO es consumida por los LWC activos (reporteKaufmann, reportePptBuilder).
 * Se conserva por compatibilidad con automatizaciones que pudieran invocarla.
 * Para nuevas implementaciones usar ReporteKaufmannController.
 *
 * Alineada en Fase 3 con el modelo real (ID_del_Reporte__c), endurecida con WITH SECURITY_ENFORCED
 * y validacion CRUD minima. Originalmente referenciaba un campo Report_ID__c que nunca existio en
 * la org, por lo que la version previa de esta clase no era funcional.
 */
public with sharing class ReporteExportController {
    
    @AuraEnabled(cacheable=true)
    public static List<Report> getAvailableReports() {
        return [
            SELECT Id, Name
            FROM Report
            WITH SECURITY_ENFORCED
            ORDER BY LastViewedDate DESC NULLS LAST
            LIMIT 20
        ];
    }

    @AuraEnabled
    public static String getReportData(Id reportId) {
        try {
            if (reportId == null) throw new AuraHandledException('El Id del reporte es obligatorio.');
            Reports.ReportResults results = Reports.ReportManager.runReport(reportId, true);
            return JSON.serialize(results);
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            System.debug('ERROR ReporteExportController.getReportData: ' + e.getMessage() + ' línea ' + e.getLineNumber());
            throw new AuraHandledException('Error al ejecutar el reporte: ' + e.getMessage());
        }
    }

    /* Alineado con el modelo real del custom object: el campo de lookup es ID_del_Reporte__c
       (no Report_ID__c, que nunca existió en la org). Name es autonumber, no se asigna en insert. */
    @AuraEnabled
    public static void saveTemplate(String reportId, String jsonConfig) {
        try {
            if (String.isBlank(reportId)) throw new AuraHandledException('El Id del reporte es obligatorio.');
            List<Plantilla_Reporte__c> existing = [
                SELECT Id FROM Plantilla_Reporte__c WHERE ID_del_Reporte__c = :reportId
                WITH SECURITY_ENFORCED LIMIT 1
            ];

            if (existing.isEmpty()) {
                if (!Plantilla_Reporte__c.SObjectType.getDescribe().isCreateable()) {
                    throw new AuraHandledException('No tienes permiso para crear plantillas.');
                }
                Plantilla_Reporte__c rec = new Plantilla_Reporte__c(
                    ID_del_Reporte__c = reportId,
                    Configuracion_JSON__c = jsonConfig
                );
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.CREATABLE, new List<Plantilla_Reporte__c>{ rec });
                insert dec.getRecords();
            } else {
                if (!Plantilla_Reporte__c.SObjectType.getDescribe().isUpdateable()) {
                    throw new AuraHandledException('No tienes permiso para actualizar plantillas.');
                }
                existing[0].Configuracion_JSON__c = jsonConfig;
                SObjectAccessDecision dec = Security.stripInaccessible(AccessType.UPDATABLE, new List<Plantilla_Reporte__c>{ existing[0] });
                update dec.getRecords();
            }
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Error al guardar plantilla: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static String getTemplate(String reportId) {
        if (String.isBlank(reportId)) return null;
        List<Plantilla_Reporte__c> existing = [
            SELECT Configuracion_JSON__c FROM Plantilla_Reporte__c WHERE ID_del_Reporte__c = :reportId
            WITH SECURITY_ENFORCED LIMIT 1
        ];
        return existing.isEmpty() ? null : existing[0].Configuracion_JSON__c;
    }
}