// Google Charts for Experience Timeline
google.charts.load('current', { 'packages': ['timeline'] });
google.charts.setOnLoadCallback(initializePortfolio);

function initializePortfolio() {
    drawTimeline();
    populateSkillsList();
    populateProjectsList();
    initializeParticles();
    addSubtleAnimations();
    initializeTypingEffect();
}

function drawTimeline() {
    const container = document.getElementById('timeline');
    if (!container) return;

    const chart = new google.visualization.Timeline(container);
    const dataTable = new google.visualization.DataTable();

    dataTable.addColumn({ type: 'string', id: 'Role' });
    dataTable.addColumn({ type: 'string', id: 'Company' });
    dataTable.addColumn({ type: 'date', id: 'Start' });
    dataTable.addColumn({ type: 'date', id: 'End' });

    const rows = [
        ['AI Research Intern', 'ISRO - Indian Space Research Organization', new Date(2015, 4), new Date(2015, 6)],
        ['Software Engineer', 'Tata Consultancy Services', new Date(2017, 10), new Date(2019, 9)],
        ['Software Architect', 'RadianArc Technologies Pvt Ltd', new Date(2019, 9), new Date(2021, 2)],
        ['Data Architect', 'INECTA - Microsoft Dynamics 365 Gold Certified Partner', new Date(2021, 2), new Date(2022, 7)],
        ['Master in Data Analytics Engineering', 'George Mason University', new Date(2022, 7), new Date()],
        ['AI Engineer', 'Sorcero', new Date(2024, 0), new Date()]
    ];

    dataTable.addRows(rows.reverse());
    chart.draw(dataTable);

    google.visualization.events.addListener(chart, 'select', function () {
        const selectedItem = chart.getSelection()[0];
        if (selectedItem) {
            const role = dataTable.getValue(selectedItem.row, 0);
            const company = dataTable.getValue(selectedItem.row, 1);
            const descriptions = {
                'AI Engineer': `Sorcero [Jan 2024 - Present] DC, USA
                    <ul>
                        <li>Spearheaded the design and deployment of a Retrieval-Augmented Generation (RAG) application on Google Cloud's Vertex AI, Gemini Pro.</li>
                        <li>Designed and implemented a knowledge graph for organizing and connecting diverse medical datasets.</li>
                        <li>Conducted sentiment analysis on medical expert records to determine product safety for various diseases.</li>
                        <li>Integrated and optimized Elastic Search and neo4j for advanced data querying, supporting real-time analytics.</li>
                        <li>Utilized Langchain and LlamaIndex for chain of thought processing and automated calls between LLM and execution chain.</li>
                        <li>Designed and implemented an agentic framework for choosing the best tools for answering customer queries in a RAG system.</li>
                    </ul>`,
                'Data Architect': `INECTA [March 2021 - August 2022] IN, DELHI, Delhi
                    <ul>
                        <li>Led the design and implementation of a system for transforming customer data into visual insights through natural language processing.</li>
                        <li>Optimized the performance of ADF pipelines for Shopify API by 16X, and for EDI documents by 5X.</li>
                        <li>Successfully migrated from Power-BI to Dash-Plotly for rapid visualization of inventory data and critical KPIs.</li>
                        <li>Increased operational efficiency by 50%, resulting in a cost savings of 50%.</li>
                        <li>Integrated OpenAI and Azure OpenAI APIs for enhanced natural language understanding and insights generation.</li>
                        <li>Established robust data security measures for multi-tenant environments.</li>
                    </ul>`,
                'Software Architect': `Radianarc Technologies Pvt Ltd [October 2019 - March 2021] IN, TELANGANA, Hyderabad
                    <ul>
                        <li>Developed forecasting models for processed vibration data, achieving over 90% prediction accuracy for machinery failure.</li>
                        <li>Created a rule engine to analyze and extract features for determining machinery time to failure, with over 85% prediction accuracy.</li>
                        <li>Integrated systems for checking IoT sensor health, resulting in over 95% uptime.</li>
                        <li>Developed an alert system reducing machinery downtime by over 50%.</li>
                    </ul>`,
                'Software Engineer': `Tata Consultancy Services [November 2017 - October 2019] IN, TAMILNADU, Chennai
                    <ul>
                        <li>Responsible for end-to-end application and performance/Load testing on Load runner.</li>
                        <li>Introduced automation to the team, reducing manual hours for test cases by more than 30%.</li>
                    </ul>`,
                'AI Research Intern': `Indian Space Research Organization [May 2015 - July 2015] IN, TELANGANA, Hyderabad
                    <ul>
                        <li>Implemented frame-sync generation and detection logic using TTL (time to live) ICs.</li>
                        <li>Interfaced 8751 microcontroller with HDSP display.</li>
                    </ul>`,
                'Master in Data Analytics Engineering': `George Mason University - Fairfax, Virginia [August 2022 – Present]
                    <ul>
                        <li>Pursuing a Master's degree in Data Analytics Engineering (DAEN).</li>
                        <li>Conducted projects on lung cancer screening analysis, personality traits and music genre preferences, and optimal bid range determination for KC-135 Training System Instructors.</li>
                    </ul>`
            };

            const chartInfo = document.getElementById("chartInfo");
            if (chartInfo) {
                chartInfo.innerHTML = `
                    <strong>Role:</strong> ${role} <br>
                    <strong>Company:</strong> ${company} <br>
                    <strong>Description:</strong> ${descriptions[role]}
                `;
            }
        }
    });
}

// Populate Skills List
function populateSkillsList() {
    const skillsData = [
        { name: 'Python', proficiency: 95 },
        { name: 'Machine Learning', proficiency: 90 },
        { name: 'Deep Learning', proficiency: 85 },
        { name: 'Natural Language Processing', proficiency: 88 },
        { name: 'Computer Vision', proficiency: 82 },
        { name: 'Data Analysis', proficiency: 92 },
        { name: 'SQL', proficiency: 85 },
        { name: 'Cloud Computing (AWS, Azure, GCP)', proficiency: 80 },
        { name: 'Docker', proficiency: 75 },
        { name: 'Git', proficiency: 88 },
        { name: 'TensorFlow', proficiency: 85 },
        { name: 'PyTorch', proficiency: 82 },
        { name: 'Scikit-learn', proficiency: 90 },
        { name: 'Pandas', proficiency: 92 },
        { name: 'NumPy', proficiency: 90 }
    ];

    const skillsList = document.getElementById("skillsList");
    if (skillsList) {
        skillsList.innerHTML = skillsData.map(skill => `
            <div class="skill-item">
                <span class="skill-name">${skill.name}</span>
                <div class="skill-bar">
                    <div class="skill-progress" style="width: 0%;" data-width="${skill.proficiency}%"></div>
                </div>
            </div>
        `).join('');

        // Animate skill bars
        setTimeout(() => {
            document.querySelectorAll('.skill-progress').forEach(bar => {
                bar.style.width = bar.dataset.width;
            });
        }, 500);
    }
}

// Populate Projects List
function populateProjectsList() {
    const projectsData = [
        {
            title: "Lung Cancer Screening Analysis Using All of Us Data",
            description: "Developed a comprehensive model for lung cancer screening using patient data from the All of Us Research Program. Utilized LASSO regression analysis to identify key risk factors and predict lung cancer occurrence with high accuracy.",
            technologies: "Python, LASSO Regression, Data Analysis, Scikit-learn, Pandas",
            image: "https://source.unsplash.com/V5vqWC9gyEU/800x600",
            link: "https://github.com/yourusername/lung-cancer-screening",
            category: "ai"
        },
        {
            title: "ChatGPT API Integration with Customer Data Platform",
            description: "Seamlessly integrated ChatGPT API with a Customer Data Platform, enabling natural language data querying. This revolutionary approach transformed stakeholder data access, improving efficiency and user experience significantly.",
            technologies: "ChatGPT API, Natural Language Processing, Python, Flask, RESTful API",
            image: "https://source.unsplash.com/m_HRfLhgABo/800x600",
            link: "https://github.com/yourusername/chatgpt-cdp-integration",
            category: "ai"
        },
        {
            title: "Personality Traits and Music Genre Preferences Analysis",
            description: "Conducted an in-depth analysis of a Spotify dataset comprising over 10,000 users to explore the intricate relationship between personality traits and music genre preferences. Identified strong correlations with a Pearson coefficient of 0.68, providing valuable insights for music recommendation systems.",
            technologies: "Python, Tableau, Statistical Analysis, Pandas, Seaborn",
            image: "https://source.unsplash.com/8Vt2haq8NSQ/800x600",
            link: "https://github.com/yourusername/music-personality-analysis",
            category: "data"
        },
        {
            title: "Optimal Bid Range Determination for KC-135 Training System",
            description: "Developed a sophisticated model to determine the optimal bid range for hiring instructors for the KC-135 Training System. Utilized analytical solver in Excel and implemented simplex methods with non-linear equations to optimize resource allocation and cost-efficiency.",
            technologies: "Excel, Analytical Solver, Simplex Method, Operations Research",
            image: "https://source.unsplash.com/7iT12M3G8Yo/800x600",
            link: "https://github.com/yourusername/kc135-bid-optimization",
            category: "data"
        }
    ];

    const projectsList = document.getElementById("projectsList");
    if (projectsList) {
        projectsList.innerHTML = projectsData.map(project => `
            <div class="col-md-6 mb-4 project-item" data-category="${project.category}">
                <div class="project-card">
                    <div class="project-image" style="background-image: url('${project.image}');"></div>
                    <div class="card-body">
                        <h5 class="card-title">${project.title}</h5>
                        <p class="card-text">${project.description}</p>
                        <p class="card-text"><small class="text-muted">Technologies: ${project.technologies}</small></p>
                    </div>
                </div>
            </div>
        `).join('');
    }

    // Project filtering
    const filterButtons = document.querySelectorAll('.filter-btn');
    filterButtons.forEach(button => {
        button.addEventListener('click', () => {
            const filter = button.getAttribute('data-filter');
            filterProjects(filter);
        });
    });
}

function filterProjects(filter) {
    const projectItems = document.querySelectorAll('.project-item');
    projectItems.forEach(item => {
        if (filter === 'all' || item.getAttribute('data-category') === filter) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });
}

// Intersection Observer for scroll animations
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        }
    });
}, { threshold: 0.1 });

document.querySelectorAll('.section').forEach(section => {
    observer.observe(section);
});

// Dark mode toggle
function initializeDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    const body = document.body;
    const icon = darkModeToggle.querySelector('i');

    darkModeToggle.addEventListener('click', () => {
        body.classList.toggle('dark-mode');
        if (body.classList.contains('dark-mode')) {
            icon.classList.remove('fa-moon');
            icon.classList.add('fa-sun');
        } else {
            icon.classList.remove('fa-sun');
            icon.classList.add('fa-moon');
        }
    });
}

// Smooth scrolling
function initializeSmoothScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });
}

// Back to Top button functionality
function initializeBackToTop() {
    const backToTopButton = document.getElementById('backToTop');

    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
            backToTopButton.style.display = 'block';
        } else {
            backToTopButton.style.display = 'none';
        }
    });

    backToTopButton.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
}

// Particle.js configuration
function initializeParticles() {
    particlesJS("particles-js", {
        particles: {
            number: { value: 80, density: { enable: true, value_area: 800 } },
            color: { value: "#ffffff" },
            shape: { 
                type: "circle",
                stroke: { width: 0, color: "#000000" },
                polygon: { nb_sides: 5 },
            },
            opacity: { 
                value: 0.5,
                random: true,
                anim: { enable: true, speed: 1, opacity_min: 0.1, sync: false }
            },
            size: {
                value: 3,
                random: true,
                anim: { enable: true, speed: 2, size_min: 0.1, sync: false }
            },
            line_linked: {
                enable: true,
                distance: 150,
                color: "#ffffff",
                opacity: 0.4,
                width: 1
            },
            move: {
                enable: true,
                speed: 2,
                direction: "none",
                random: true,
                straight: false,
                out_mode: "out",
                bounce: false,
                attract: { enable: false, rotateX: 600, rotateY: 1200 }
            }
        },
        interactivity: {
            detect_on: "canvas",
            events: {
                onhover: { enable: true, mode: "grab" },
                onclick: { enable: true, mode: "push" },
                resize: true
            },
            modes: {
                grab: { distance: 140, line_linked: { opacity: 1 } },
                bubble: { distance: 400, size: 40, duration: 2, opacity: 8, speed: 3 },
                repulse: { distance: 200, duration: 0.4 },
                push: { particles_nb: 4 },
                remove: { particles_nb: 2 }
            }
        },
        retina_detect: true
    });
}

// Add subtle animations to elements
function addSubtleAnimations() {
    const elements = document.querySelectorAll('.skill-item, .project-card, .section h2');
    elements.forEach((el, index) => {
        el.style.animation = `fadeInUp 0.6s ease-out ${index * 0.1}s both`;
    });
}

// Initialize typing effect
function initializeTypingEffect() {
    const options = {
        strings: ['an AI Engineer', 'a Machine Learning Specialist', 'a Data Scientist', 'a Problem Solver'],
        typeSpeed: 50,
        backSpeed: 50,
        loop: true,
        cursorChar: '|',
    };

    new Typed('#typing-effect', options);
}

// Color theme switcher
function initializeColorThemeSwitcher() {
    const colorThemeButtons = document.querySelectorAll('.color-theme');
    const root = document.documentElement;

    colorThemeButtons.forEach(button => {
        button.addEventListener('click', () => {
            const theme = button.getAttribute('data-theme');
            switch (theme) {
                case 'blue':
                    root.style.setProperty('--primary-color', '#3477db');
                    root.style.setProperty('--secondary-color', '#367d54');
                    break;
                case 'green':
                    root.style.setProperty('--primary-color', '#4CAF50');
                    root.style.setProperty('--secondary-color', '#2196F3');
                    break;
                case 'purple':
                    root.style.setProperty('--primary-color', '#9C27B0');
                    root.style.setProperty('--secondary-color', '#E91E63');
                    break;
            }
        });
    });
}

// Initialize everything when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    initializeDarkMode();
    initializeSmoothScrolling();
    initializeBackToTop();
    initializeColorThemeSwitcher();
});