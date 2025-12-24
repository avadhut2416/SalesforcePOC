import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningModal from 'lightning/modal';
import { loadScript } from 'lightning/platformResourceLoader';
import sheetjs from '@salesforce/resourceUrl/sheetjs';
import uploadNewFileVersion from '@salesforce/apex/ProcessActualizationDataController.uploadNewFileVersion';

let XLS = {};

export default class ProcessActualizationUpload extends LightningModal {

    @api region;
    @track acceptedFormats = ['.xls', '.xlsx'];
    @track actualizationData = [];
    @track isAPACRegion = false;
    isLoading = false;
    disablePreviewDataBtn = true;
    scheduleDate;
    numOfRecordsToProcess = 0;
    excelContentVerId;

    connectedCallback() {
        console.log('connectedCallback ProcessActualizationUpload');
        if(this.region === 'NTAM'){
           this.acceptedFormats.push('.xlsm');
        }else{
            this.isAPACRegion = true;
        }
        this._loadExcelScipt();
    }

    handleUploadFinished(event) {
        this.isLoading = true;
        try {
            const uploadedFiles = event.detail.files;
            if (uploadedFiles.length > 0) {
                 this._ExcelToJSON(uploadedFiles[0]);
            } else {
                this.showToast('Error', 'No file selected', 'error');
            }
        } catch (error) {
            this.showToast('Error', 'Error uploading the file ' + JSON.stringify (error), 'error');
        }
    }

    _ExcelToJSON(file) {
        var reader = new FileReader();
         reader.onload = event => {
            var data = event.target.result;
            var workbook = XLS.read(data, { type: 'binary' });
            if(this.region === 'APAC'){
                let XL_row_object = XLS.utils.sheet_to_row_object_array(workbook.Sheets["Sheet1"]);
                const dateKey = Object.keys(XL_row_object[0])[0];
                console.log('RAW APAC DATA:', XL_row_object);

                this.scheduleDate = this._detectMonthColumn(XL_row_object[0]);
                this.actualizationData = this._cleanAPACJsonData(XL_row_object);
            }else if(this.region === 'EMEA'){
                let XL_row_object = XLS.utils.sheet_to_row_object_array(workbook.Sheets[workbook.SheetNames[0]]);
                const dateKey = Object.keys(XL_row_object[0])[1];
                this.scheduleDate = dateKey;
                this._cleanEMEAJsonData(XL_row_object);
            }else{
                for (var i = 0; i < workbook.SheetNames.length; ++i) {
                    let XL_row_object = XLS.utils.sheet_to_row_object_array(workbook.Sheets[workbook.SheetNames[i]]);
                    this._cleanUSJsonData(XL_row_object);
              
        };

        reader.onerror = ex => {
            this.isLoading = false;
            this.showToast('Error', 'Error reading the file ' + JSON.stringify(ex), 'error');
        };

        reader.readAsBinaryString(file);
    }


    _cleanAPACJsonData(data) {
    let cleanData = [];

    if (!data || data.length === 0) {
        console.warn('No rows found in Excel');
        return [];
    }

    data.forEach((item, index) => {

        // 🔑 dynamically find Sell Line column (handles spaces/case issues)
        const sellLineKey = Object.keys(item).find(
            k => k.replace(/\s+/g, '').toLowerCase() === 'sellline'
        );

        const row = {
            SellLine: sellLineKey ? item[sellLineKey] : '',
            Clicks: Number(item['Clicks'] || 0),
            Views: Number(item['Views'] || 0),
            CompletedViews: Number(item['Completed Views'] || item['CompletedViews'] || 0),
            Conversions: Number(item['Conversions'] || 0),
            Impressions: Number(item[this.scheduleDate] || 0),
            Budget: Number(item['Budget'] || 0),
            Cost: Number(item['Cost'] || 0),
            CurrencyISOCode: item['Currency ISO Code'] || item['CurrencyISOCode'] || '',
            DSP: item['DSP'] || ''
        };

        console.log(`ROW ${index}:`, row);

        if (row.SellLine && row.SellLine.toString().trim() !== '') {
            cleanData.push(row);
        }
    });

    return cleanData;
}



    _cleanEMEAJsonData(data) {
        for (let i = 1; i < data.length; i++) {
            const item = data[i];
            const row = {
                SellLine: item['Schedule Name'] || '',
                Quantity: item[this.scheduleDate] || 0,
                Budget: item['__EMPTY'] || 0,
                Cost: item['__EMPTY_1'] || 0
            };
            this.actualizationData.push(row);
        }
    }

    _cleanUSJsonData(data) {
        for (let i = 0; i < data.length; i++) {
            if((data[i])['SF_CAMPAIGN_ID']){  // Find the first row containing the Column Headers.
                const item = data[i];
                let previousItem = this.actualizationData.find(
                    row => row.campaignID === item['SF_CAMPAIGN_ID']);
                if(previousItem){
                    previousItem.billableSpend = previousItem.billableSpend + (item['Actualized Billable Spend'] || item[' Actualized Billable Spend '] || 0);
                    previousItem.payableSpend = previousItem.payableSpend + (item['Actualized Payable Spend'] || item[' Actualized Payable Spend '] || 0);
                    previousItem.billableUnits = previousItem.billableUnits + (item['Actualized Billable Units'] || item[' Actualized Billable Units '] || 0);
                    previousItem.payableUnits  = previousItem.payableUnits + (item['Actualized Payable Units'] || item[' Actualized Payable Units '] || 0);
                }
                else{
                    const row = {
                        campaignID: item['SF_CAMPAIGN_ID'] || '',
                        billableUnits: item['Actualized Billable Units'] || item[' Actualized Billable Units '] || 0,
                        billableSpend: item['Actualized Billable Spend'] || item[' Actualized Billable Spend '] || 0,
                        payableUnits: item['Actualized Payable Units'] || item[' Actualized Payable Units '] || 0,
                        payableSpend: item['Actualized Payable Spend'] || item[' Actualized Payable Spend '] || 0
                    }; 
                
                    this.actualizationData.push(row);
                
                }
            }
        }
    }

    handlePreviewDataClick() {
        let uploadResult = {
            actualizationData : this.actualizationData,
            scheduleDate : this.scheduleDate,
            excelContentVerId : this.excelContentVerId
        };
        console.log('uploadResult::',uploadResult);
        this.close(uploadResult);
    }


    _saveNewFileVerison(file) {
        let fileData = {
            'pathOnClient': 'file.xlsx',
            'base64': window.btoa(file)
        };
        uploadNewFileVersion({ fileDataJSON: JSON.stringify(fileData), region : this.region}).then(res => {
            if (res) {
                this.excelContentVerId = res;
                this.isLoading = false;
                this.numOfRecordsToProcess = this.actualizationData.length;
                this.disablePreviewDataBtn = false; 
                this.actualizationResults = this.actualizationData;          
                this.showToast('Success', 'File uploaded successfully. ' + this.numOfRecordsToProcess + ' records were extracted from the file.', 'success');
            }
        }).catch(error => {
            this.showToast('Error', 'Error saving file. ' + JSON.stringify (error), 'error');
        });
    }
    _loadExcelScipt() {
        Promise.all([
            loadScript(this, sheetjs)
        ]).then(() => {
            XLS = XLSX;
        }).catch(error => {
            this.showToast('Error', error, 'error');
        });
    }

    _detectMonthColumn(firstRow) {
        if (!firstRow) return null;

        return Object.keys(firstRow).find(
            k => /\d{1,2}\/\d{4}/.test(k)
        );
    }

    showToast(title, message, variant) {
        const event = new ShowToastEvent({
            title: title,
            message: message,
            variant: variant,
        });
        this.dispatchEvent(event);
    }
}
