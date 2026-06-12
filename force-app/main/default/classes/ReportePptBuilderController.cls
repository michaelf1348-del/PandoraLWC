/**
 * @deprecated DEPRECATED desde Fase 3 de Pandora (2026).
 * Esta clase implementa la generación de PPT vía CALLOUT externo (Named Credential "PptBuilder").
 * El flujo activo actual genera el PPT en cliente con PptxGenJS (LWC reportePptBuilder).
 * Esta clase NO es consumida por ningún LWC activo en el repo. Se conserva por compatibilidad
 * con automatizaciones externas. Para nuevas implementaciones usar el flujo cliente.
 */
public with sharing class ReportePptBuilderController {
    // -----------------------------
    // DTO interno para configuración
    // -----------------------------
    private class PptCfg {
        public Id templateContentDocumentId;
        public Integer slideIndex;
        public String placeholderName;
    }

    // -------------------------------------------------
    // Lee configuración desde Custom Metadata (Default)
    // -------------------------------------------------
    private static PptCfg getCfg() {
        // ✅ IMPORTANTE: Este es tu API Name real
        PptTemplateConfig_mdt__mdt cfg = [
            SELECT TemplateContentDocumentId__c, SlideIndex__c, PlaceholderName__c
            FROM PptTemplateConfig_mdt__mdt
            WHERE DeveloperName = 'Default'
            LIMIT 1
        ];

        // ✅ FIX: condición correcta (antes estaba mal formada)
        if (cfg == null || String.isBlank(cfg.TemplateContentDocumentId__c)) {
            throw new AuraHandledException(
                'Plantilla PPTX no configurada en Custom Metadata (registro Default).'
            );
        }

        PptCfg out = new PptCfg();
        out.templateContentDocumentId = (Id) cfg.TemplateContentDocumentId__c;

        // Si no viene slide, por defecto 2 (tu prueba)
        out.slideIndex = (cfg.SlideIndex__c == null)
            ? 2
            : Integer.valueOf(cfg.SlideIndex__c);

        // Si no viene placeholder, por defecto TablaKaufmann
        out.placeholderName = String.isBlank(cfg.PlaceholderName__c)
            ? 'TablaKaufmann'
            : cfg.PlaceholderName__c;

        return out;
    }

    // -------------------------------------------------
    // Método invocado por LWC
    // -------------------------------------------------
    @AuraEnabled
    public static Id buildFromExcel(
        Id recordId,
        Id excelContentDocumentId,
        String sheetName,
        String range,
        Integer slideIndex // lo mantenemos por compatibilidad con tu LWC (aunque no lo usamos)
    ) {
        if (excelContentDocumentId == null) {
            throw new AuraHandledException('Debes cargar un Excel.');
        }
        if (String.isBlank(range)) {
            throw new AuraHandledException('El rango es obligatorio (ej: B3:F18).');
        }
        if (String.isBlank(sheetName)) {
            sheetName = 'Hoja1';
        }

        // ✅ 1) Configuración desde Custom Metadata
        PptCfg cfg = getCfg();

        // ---------------------------
        // Excel: última versión
        // ---------------------------
        List<ContentVersion> excelList = [
            SELECT Id
            FROM ContentVersion
            WHERE ContentDocumentId = :excelContentDocumentId
            ORDER BY VersionNumber DESC
            LIMIT 1
        ];

        if (excelList.isEmpty()) {
            throw new AuraHandledException(
                'No se encontró el Excel en ContentVersion. ' +
                'Verifica que subiste el archivo y que estás pasando un ContentDocumentId (069...). ' +
                'ID recibido: ' + String.valueOf(excelContentDocumentId)
            );
        }
        ContentVersion excelCv = excelList[0];

        // ---------------------------
        // Plantilla PPTX: última versión
        // ---------------------------
        List<ContentVersion> templateList = [
            SELECT Id
            FROM ContentVersion
            WHERE ContentDocumentId = :cfg.templateContentDocumentId
            ORDER BY VersionNumber DESC
            LIMIT 1
        ];

        if (templateList.isEmpty()) {
            throw new AuraHandledException(
                'No se encontró la plantilla PPTX en ContentVersion. ' +
                'ID configuración: ' + String.valueOf(cfg.templateContentDocumentId)
            );
        }
        ContentVersion pptTemplateCv = templateList[0];

        // ✅ 4) Payload al servicio externo
        Map<String, Object> payload = new Map<String, Object>{
            'excelContentVersionId' => excelCv.Id,
            'pptTemplateContentVersionId' => pptTemplateCv.Id,
            'sheetName' => sheetName,
            'range' => range,
            'slideIndex' => cfg.slideIndex,
            'target' => new Map<String, Object>{
                'mode' => 'placeholder',
                'shapeName' => cfg.placeholderName
            }
        };

        // ✅ 5) Callout al builder (Named Credential: PptBuilder)
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:PptBuilder/build');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setBody(JSON.serialize(payload));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new AuraHandledException(
                'Error en servicio PPT Builder: ' + res.getStatus() + ' - ' + res.getBody()
            );
        }

        // ✅ 6) Esperamos {"pptxBase64":"..."}
        Map<String, Object> out = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        String pptBase64 = (String) out.get('pptxBase64');
        if (String.isBlank(pptBase64)) {
            throw new AuraHandledException('Respuesta inválida: no viene pptxBase64.');
        }

        Blob pptBlob = EncodingUtil.base64Decode(pptBase64);

        // ✅ 7) Guardar PPTX generado en Files
        ContentVersion generated = new ContentVersion();
        generated.Title = 'Reporte PPT - ' + Date.today().format();
        generated.PathOnClient = 'ReportePPT.pptx';
        generated.VersionData = pptBlob;
        insert generated;

        // ✅ 8) Vincular al registro (si aplica)
        if (recordId != null) {
            // ✅ FIX: sintaxis correcta para ContentDocumentLink
            ContentDocumentLink cdl = new ContentDocumentLink();
            cdl.ContentDocumentId = generated.ContentDocumentId;
            cdl.LinkedEntityId = recordId;
            cdl.ShareType = 'V';
            cdl.Visibility = 'AllUsers';
            insert cdl;
        }

        return generated.ContentDocumentId;
    }
}