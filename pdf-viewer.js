// PDF Viewer Implementation
const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class ResumeViewer {
    constructor(pdfUrl, containerId) {
        this.pdfUrl = pdfUrl;
        this.container = document.getElementById(containerId);
        this.currentPage = 1;
        this.pdfDoc = null;
        this.pageRendering = false;
        this.pageNumPending = null;
        this.scale = 1.5;
        
        this.initialize();
    }

    async initialize() {
        try {
            // Create viewer controls
            this.createControls();
            
            // Load the PDF
            this.pdfDoc = await pdfjsLib.getDocument(this.pdfUrl).promise;
            document.getElementById('page_count').textContent = this.pdfDoc.numPages;
            
            // Initial page render
            this.renderPage(this.currentPage);
            
            // Add event listeners
            this.addEventListeners();
        } catch (error) {
            console.error('Error initializing PDF viewer:', error);
            this.container.innerHTML = `
                <div class="alert alert-danger" role="alert">
                    Unable to load PDF. Please try downloading it directly.
                    <a href="${this.pdfUrl}" class="btn btn-primary ml-3" download>Download Resume</a>
                </div>
            `;
        }
    }

    createControls() {
        this.container.innerHTML = `
            <div class="pdf-controls mb-3">
                <button id="prev" class="btn btn-primary me-2">
                    <i class="fas fa-chevron-left"></i> Previous
                </button>
                <button id="next" class="btn btn-primary me-2">
                    Next <i class="fas fa-chevron-right"></i>
                </button>
                <span class="mx-2">
                    Page: <span id="page_num">${this.currentPage}</span> / 
                    <span id="page_count">0</span>
                </span>
                <button id="zoomIn" class="btn btn-secondary me-2">
                    <i class="fas fa-search-plus"></i>
                </button>
                <button id="zoomOut" class="btn btn-secondary me-2">
                    <i class="fas fa-search-minus"></i>
                </button>
                <a href="${this.pdfUrl}" class="btn btn-success" download>
                    <i class="fas fa-download"></i> Download PDF
                </a>
            </div>
            <div class="pdf-container">
                <canvas id="pdf_renderer" class="shadow"></canvas>
            </div>
        `;
    }

    addEventListeners() {
        document.getElementById('prev').addEventListener('click', () => {
            if (this.currentPage <= 1) return;
            this.queueRenderPage(--this.currentPage);
        });

        document.getElementById('next').addEventListener('click', () => {
            if (this.currentPage >= this.pdfDoc.numPages) return;
            this.queueRenderPage(++this.currentPage);
        });

        document.getElementById('zoomIn').addEventListener('click', () => {
            this.scale *= 1.2;
            this.renderPage(this.currentPage);
        });

        document.getElementById('zoomOut').addEventListener('click', () => {
            this.scale *= 0.8;
            this.renderPage(this.currentPage);
        });
    }

    async renderPage(num) {
        this.pageRendering = true;
        const page = await this.pdfDoc.getPage(num);
        
        const canvas = document.getElementById('pdf_renderer');
        const ctx = canvas.getContext('2d');
        
        const viewport = page.getViewport({ scale: this.scale });
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };

        try {
            await page.render(renderContext).promise;
            this.pageRendering = false;
            
            if (this.pageNumPending !== null) {
                this.renderPage(this.pageNumPending);
                this.pageNumPending = null;
            }
        } catch (error) {
            console.error('Error rendering PDF page:', error);
            this.pageRendering = false;
        }

        document.getElementById('page_num').textContent = num;
    }

    queueRenderPage(num) {
        if (this.pageRendering) {
            this.pageNumPending = num;
        } else {
            this.renderPage(num);
        }
    }
}

// Initialize the viewer when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Create resume section if it doesn't exist
    if (!document.getElementById('resume')) {
        const resumeSection = document.createElement('section');
        resumeSection.id = 'resume';
        resumeSection.className = 'section bg-light';
        resumeSection.innerHTML = `
            <div class="container">
                <h2 class="text-center mb-5" data-aos="fade-up">Resume</h2>
                <div id="pdf_viewer" class="pdf-viewer-container"></div>
            </div>
        `;
        
        // Insert before the contact section
        const contactSection = document.getElementById('contact');
        contactSection.parentNode.insertBefore(resumeSection, contactSection);
    }
    
    // Initialize the PDF viewer
    new ResumeViewer('image/Profile.pdf', 'pdf_viewer');
});
