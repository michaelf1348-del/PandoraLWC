import { LightningElement, track } from 'lwc';

export default class PandoraPptOrchestrator extends LightningElement {
    @track isStep1 = true;
    @track generatedExcelId;
    @track generatedSheetName;
    @track selectedReportId;
    /* Metadatos opcionales de la variante activa de reporteKaufmann que generó el Excel.
       Se propagan al PPT builder solo como contexto visual / para el filename .pptx;
       el storage del PPT sigue siendo por reportId. */
    @track selectedVariantId;
    @track selectedVariantName;

    handleNextStep(event) {
        this.generatedExcelId = event.detail.excelDocumentId;
        this.generatedSheetName = event.detail.sheetName;
        this.selectedReportId = event.detail.reportId;
        this.selectedVariantId = event.detail.varianteId || null;
        this.selectedVariantName = event.detail.varianteName || null;
        this.isStep1 = false;
    }

    handleBackStep() {
        this.isStep1 = true;
    }
}