public with sharing class PandoraTemplateController {

    @AuraEnabled
    public static Id saveTemplate(Plantillas_Power_Point__c templateRecord) {
        try {
            upsert templateRecord;
            return templateRecord.Id;
        } catch (Exception e) {
            throw new AuraHandledException('Error al guardar la plantilla: ' + e.getMessage());
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<Plantillas_Power_Point__c> getTemplates() {
        return [
            SELECT Id, Name, Activo__c, Color_Primario__c, Color_Secundario__c,
                   Fuente_Corporativa__c, Configuracion_JSON__c, Fondo_Diapositiva_Id__c,
                   LastModifiedDate
            FROM Plantillas_Power_Point__c
            ORDER BY CreatedDate DESC
        ];
    }
}