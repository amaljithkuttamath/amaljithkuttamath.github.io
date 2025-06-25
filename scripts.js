// Simple and clean portfolio JavaScript
document.addEventListener("DOMContentLoaded", function () {
    // Project data - simplified
    const projectsData = [
        {
            id: "falconProject",
            title: "Falcon: Chat with Your Data",
            description: "Led a 6-person team to develop conversational data analytics using fine-tuned Codellama-34B and Mistral-7B models.",
            categories: ["ai", "nlp"],
            technologies: "Python, Codellama-34B, Mistral-7B, LangChain, SQL",
            role: "Team Lead & Technical Architect",
            company: "GMU Capstone Project",
            period: "2024",
            impact: "Democratized data analytics for non-technical users",
            demo: "https://lnkd.in/gMbtYs25"
        },
        {
            id: "medicalRAG",
            title: "Medical RAG System",
            description: "Developing advanced RAG applications using Google Cloud's Vertex AI and Gemini Pro for medical records analysis.",
            categories: ["ai", "nlp", "healthcare"],
            technologies: "Python, Vertex AI, Gemini Pro, LangChain, Neo4j, Elasticsearch",
            role: "AI Engineer",
            company: "Sorcero",
            period: "May 2024 - Present",
            impact: "Enabling healthcare professionals to efficiently extract insights from medical documentation"
        },
        {
            id: "predictiveMaintenance",
            title: "Industrial Predictive Maintenance System", 
            description: "Led development of ML-powered predictive maintenance achieving 95% accuracy, reducing machine downtime by 50%.",
            categories: ["ml"],
            technologies: "Python, Azure Data Lake, Advanced Statistics, Sensor Analytics",
            role: "Solutions Architect",
            company: "RadianArc Technologies",
            period: "May 2019 - April 2021",
            impact: "Reduced unplanned downtime by 50%"
        },
        {
            id: "supplychainRAG",
            title: "Supply Chain RAG Analytics System",
            description: "Developed RAG system with GPT-3.5turbo enabling natural language queries for 5K+ inventory items.",
            categories: ["nlp", "ai", "web"],
            technologies: "GPT-3.5turbo, Azure Data Factory, Django, Flask, React, NextJS",
            role: "Technical Consultant", 
            company: "INECTA",
            period: "May 2021 - August 2022",
            impact: "Improved forecasting accuracy by 15%"
        },
        {
            id: "testAutomation",
            title: "Enterprise Test Automation Framework",
            description: "Architected automated testing ecosystem using Selenium with Cucumber framework, reducing testing time by 70%.",
            categories: ["web"],
            technologies: "Selenium, Cucumber, Java, TestNG, Jenkins",
            role: "Software Engineer",
            company: "Tata Consultancy Services", 
            period: "November 2017 - September 2019",
            impact: "Reduced manual testing effort by 70%"
        }
    ];

    // Simple utility functions
    const utils = {
        debounce: (func, wait) => {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }
    };

    // Simple navigation
    class SimpleNavigation {
        constructor() {
            this.initSmoothScroll();
            this.initScrollSpy();
        }

        initSmoothScroll() {
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
                anchor.addEventListener("click", (e) => {
                    e.preventDefault();
                    const target = document.querySelector(anchor.getAttribute("href"));
                    if (target) {
                        target.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                });
            });
        }

        initScrollSpy() {
            const sections = document.querySelectorAll("section[id]");
            const navLinks = document.querySelectorAll(".nav-link");

            const handleScroll = () => {
                const fromTop = window.scrollY + 100;

                sections.forEach(section => {
                    const { offsetTop, offsetHeight } = section;
                    
                    if (fromTop >= offsetTop && fromTop < offsetTop + offsetHeight) {
                        const id = section.getAttribute("id");
                        navLinks.forEach(link => {
                            link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
                        });
                    }
                });
            };

            window.addEventListener("scroll", utils.debounce(handleScroll, 100));
        }
    }

    // Simple theme toggle
    class SimpleTheme {
        constructor() {
            this.toggle = document.getElementById("darkModeToggle");
            this.init();
        }

        init() {
            if (!this.toggle) return;

            // Load saved theme
            const savedTheme = localStorage.getItem("darkMode") === "true";
            this.setTheme(savedTheme);

            this.toggle.addEventListener("click", () => {
                const isDark = !document.body.classList.contains("dark-mode");
                this.setTheme(isDark);
            });
        }

        setTheme(isDark) {
            document.body.classList.toggle("dark-mode", isDark);
            if (this.toggle) {
                this.toggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
            }
            localStorage.setItem("darkMode", isDark);
        }
    }

    // Simple projects manager
    class SimpleProjects {
        constructor(projects) {
            this.projects = projects;
            this.container = document.getElementById("projectsList");
            this.filterButtons = document.querySelectorAll("[data-filter]");
            this.modal = document.getElementById("projectModal");
            this.init();
        }

        init() {
            if (!this.container) {
                console.error('Projects container not found!');
                return;
            }
            
            console.log('Initializing projects with', this.projects.length, 'projects');
            this.renderProjects("all");
            this.initFilters();
            this.initModal();
        }

        renderProjects(category) {
            const filtered = category === 'all' ? 
                this.projects : 
                this.projects.filter(p => p.categories.includes(category));

            console.log('Rendering', filtered.length, 'projects for category:', category);
            const htmlContent = filtered.map(project => `
                <div class="project-card" data-project-id="${project.id}">
                    <div class="project-content">
                        <h3>${project.title}</h3>
                        <p class="project-company">${project.role} @ ${project.company} (${project.period})</p>
                        <p class="project-description">${project.description}</p>
                        
                        <div class="project-technologies">
                            ${project.technologies.split(', ').map(tech => 
                                `<span class="tech-tag">${tech}</span>`
                            ).join('')}
                        </div>
                        
                        <div class="project-links">
                            <button class="btn btn-primary" onclick="openProjectModal('${project.id}')">
                                View Details
                            </button>
                            ${project.demo ? `
                                <a href="${project.demo}" target="_blank" class="btn btn-outline">
                                    Live Demo
                                </a>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `).join('');
            
            this.container.innerHTML = htmlContent;
            console.log('Projects rendered successfully!');
        }

        initFilters() {
            this.filterButtons.forEach(button => {
                button.addEventListener("click", (e) => {
                    e.preventDefault();
                    const category = button.getAttribute("data-filter");
                    
                    // Update active state
                    this.filterButtons.forEach(btn => btn.classList.remove("active"));
                    button.classList.add("active");
                    
                    this.renderProjects(category);
                });
            });
        }

        initModal() {
            if (!this.modal) return;

            // Make openProjectModal globally available
            window.openProjectModal = (projectId) => {
                const project = this.projects.find(p => p.id === projectId);
                if (project) {
                    this.modal.querySelector(".modal-title").textContent = project.title;
                    this.modal.querySelector(".modal-body").innerHTML = `
                        <div class="project-modal-content">
                            <p><strong>Role:</strong> ${project.role} @ ${project.company} (${project.period})</p>
                            <p><strong>Description:</strong> ${project.description}</p>
                            <p><strong>Impact:</strong> ${project.impact}</p>
                            <div class="modal-tech">
                                <strong>Technologies:</strong>
                                <div class="tech-tags">
                                    ${project.technologies.split(', ').map(tech => 
                                        `<span class="tech-tag">${tech}</span>`
                                    ).join('')}
                                </div>
                            </div>
                            ${project.demo ? `
                                <div class="text-center mt-3">
                                    <a href="${project.demo}" target="_blank" class="btn btn-primary">
                                        View Live Demo
                                    </a>
                                </div>
                            ` : ''}
                        </div>
                    `;
                    
                    // Show modal (assuming Bootstrap modal)
                    try {
                        if (typeof bootstrap !== 'undefined') {
                            const modalInstance = new bootstrap.Modal(this.modal);
                            modalInstance.show();
                        } else {
                            // Fallback: simple display toggle if Bootstrap not loaded
                            this.modal.style.display = 'block';
                            this.modal.classList.add('show');
                            document.body.classList.add('modal-open');
                        }
                    } catch (error) {
                        console.error('Error showing modal:', error);
                        // Simple fallback
                        this.modal.style.display = 'block';
                        this.modal.classList.add('show');
                    }
                }
            };
        }
    }

    // Simple contact form
    class SimpleContact {
        constructor() {
            this.form = document.getElementById("contactForm");
            this.init();
        }

        init() {
            if (!this.form) return;

            this.form.addEventListener("submit", (e) => {
                e.preventDefault();
                this.handleSubmit();
            });
        }

        handleSubmit() {
            const formData = new FormData(this.form);
            const name = formData.get('name');
            const email = formData.get('email');
            const message = formData.get('message');

            // Simple validation
            if (!name || !email || !message) {
                this.showMessage('Please fill in all fields', 'error');
                return;
            }

            // Simulate form submission
            this.showMessage('Thank you for your message! I will get back to you soon.', 'success');
            this.form.reset();
        }

        showMessage(text, type) {
            const messageDiv = document.createElement('div');
            messageDiv.className = `alert alert-${type === 'success' ? 'success' : 'danger'}`;
            messageDiv.textContent = text;
            
            this.form.parentNode.insertBefore(messageDiv, this.form);
            
            setTimeout(() => {
                messageDiv.remove();
            }, 5000);
        }
    }

    // Simple typing effect
    function initTypingEffect() {
        const element = document.getElementById("typing-effect");
        if (!element) return;

        const roles = [
            'AI Engineer',
            'NLP Specialist', 
            'Faculty @GMU'
        ];

        let currentRole = 0;
        let currentChar = 0;
        let isDeleting = false;

        function type() {
            const role = roles[currentRole];
            
            if (isDeleting) {
                element.textContent = role.substring(0, currentChar - 1);
                currentChar--;
            } else {
                element.textContent = role.substring(0, currentChar + 1);
                currentChar++;
            }

            let speed = isDeleting ? 50 : 100;

            if (!isDeleting && currentChar === role.length) {
                speed = 2000;
                isDeleting = true;
            } else if (isDeleting && currentChar === 0) {
                isDeleting = false;
                currentRole = (currentRole + 1) % roles.length;
                speed = 500;
            }

            setTimeout(type, speed);
        }

        type();
    }

    // Simple PDF viewer
    function initPDFViewer() {
        const container = document.getElementById('pdf_viewer');
        if (container) {
            container.innerHTML = `
                <div class="pdf-viewer-simple">
                    <p>Download my detailed resume</p>
                    <a href="image/Profile.pdf" target="_blank" class="btn btn-primary">
                        <i class="fas fa-file-pdf"></i> View Resume
                    </a>
                    <a href="image/Profile.pdf" download="Amaljith_Kuttamath_Resume.pdf" class="btn btn-outline">
                        <i class="fas fa-download"></i> Download
                    </a>
                </div>
            `;
        }
    }

    // Skills Constellation
    class SkillsConstellation {
        constructor() {
            this.container = document.getElementById('skills-graph');
            this.detailsContainer = document.getElementById('skill-details');
            this.skills = [
                { name: 'Python', level: 95, category: 'Programming', color: '#3776ab', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Machine Learning', level: 90, category: 'AI/ML', color: '#ff6b6b', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'NLP', level: 88, category: 'AI/ML', color: '#4ecdc4', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'LangChain', level: 85, category: 'AI/ML', color: '#45b7d1', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Google Cloud', level: 82, category: 'Cloud', color: '#4285f4', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Neo4j', level: 80, category: 'Database', color: '#018bff', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'React', level: 85, category: 'Frontend', color: '#61dafb', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Django', level: 87, category: 'Backend', color: '#092e20', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Elasticsearch', level: 78, category: 'Database', color: '#f04e98', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Docker', level: 82, category: 'DevOps', color: '#0db7ed', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'Kubernetes', level: 75, category: 'DevOps', color: '#326ce5', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'TensorFlow', level: 80, category: 'AI/ML', color: '#ff6f00', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'PyTorch', level: 78, category: 'AI/ML', color: '#ee4c2c', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'JavaScript', level: 83, category: 'Programming', color: '#f7df1e', x: 0, y: 0, vx: 0, vy: 0 },
                { name: 'SQL', level: 88, category: 'Database', color: '#336791', x: 0, y: 0, vx: 0, vy: 0 }
            ];
            this.mousePosition = { x: 0, y: 0 };
            this.selectedSkill = null;
            this.animationId = null;
            this.particles = [];
            this.connections = [];
            this.hoveredSkill = null;
            this.init();
        }

        init() {
            if (!this.container) return;
            this.setupCanvas();
            this.positionSkills();
            this.render();
            this.addInteractivity();
            this.startAnimation();
            this.addMouseTracking();
            this.addKeyboardControls();
        }

        setupCanvas() {
            this.width = this.container.clientWidth || 800;
            this.height = 500;
            this.container.style.height = this.height + 'px';
            this.container.style.position = 'relative';
            this.container.style.background = 'linear-gradient(135deg, #0c1426 0%, #1a1a2e 50%, #16213e 100%)';
            this.container.style.borderRadius = '15px';
            this.container.style.overflow = 'hidden';
        }

        positionSkills() {
            const centerX = this.width / 2;
            const centerY = this.height / 2;
            const radius = Math.min(this.width, this.height) * 0.35;

            this.skills.forEach((skill, i) => {
                const angle = (i / this.skills.length) * 2 * Math.PI;
                const variance = (Math.random() - 0.5) * 100;
                skill.x = centerX + Math.cos(angle) * (radius + variance);
                skill.y = centerY + Math.sin(angle) * (radius + variance);
            });
        }

        render() {
            // Clear container
            this.container.innerHTML = '';

            // Create stars background
            this.createStarField();

            // Create skill nodes
            this.skills.forEach(skill => {
                const node = this.createSkillNode(skill);
                this.container.appendChild(node);
            });

            // Create constellation lines
            this.createConstellationLines();
            this.addInstructions();
        }

        createStarField() {
            for (let i = 0; i < 50; i++) {
                const star = document.createElement('div');
                star.className = 'star';
                star.style.cssText = `
                    position: absolute;
                    width: 2px;
                    height: 2px;
                    background: white;
                    border-radius: 50%;
                    left: ${Math.random() * this.width}px;
                    top: ${Math.random() * this.height}px;
                    animation: twinkle ${2 + Math.random() * 3}s linear infinite;
                `;
                this.container.appendChild(star);
            }
        }

        createSkillNode(skill) {
            const node = document.createElement('div');
            const size = 20 + (skill.level / 100) * 30;
            
            node.className = 'skill-node';
            node.style.cssText = `
                position: absolute;
                width: ${size}px;
                height: ${size}px;
                background: ${skill.color};
                border: 2px solid rgba(255,255,255,0.3);
                border-radius: 50%;
                left: ${skill.x - size/2}px;
                top: ${skill.y - size/2}px;
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: 0 0 20px ${skill.color}50;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-weight: bold;
                font-size: ${Math.max(8, size/4)}px;
                z-index: 10;
            `;
            
            node.textContent = skill.name.substring(0, 2).toUpperCase();
            node.setAttribute('data-skill', JSON.stringify(skill));
            
            // Hover effects
            node.addEventListener('mouseenter', () => {
                node.style.transform = 'scale(1.3)';
                node.style.boxShadow = `0 0 30px ${skill.color}`;
                node.style.zIndex = '20';
            });
            
            node.addEventListener('mouseleave', () => {
                node.style.transform = 'scale(1)';
                node.style.boxShadow = `0 0 20px ${skill.color}50`;
                node.style.zIndex = '10';
            });
            
            return node;
        }

        createConstellationLines() {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 1;
            `;

            // Connect related skills
            const connections = [
                [0, 1], [1, 2], [2, 3], [4, 8], [5, 8], [6, 13], [7, 13],
                [11, 12], [1, 11], [1, 12], [9, 10]
            ];

            connections.forEach(([i, j]) => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', this.skills[i].x);
                line.setAttribute('y1', this.skills[i].y);
                line.setAttribute('x2', this.skills[j].x);
                line.setAttribute('y2', this.skills[j].y);
                line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
                line.setAttribute('stroke-width', '1');
                line.style.animation = 'fadeInLine 2s ease-in-out';
                svg.appendChild(line);
            });

            this.container.appendChild(svg);
        }

        addInteractivity() {
            this.container.addEventListener('click', (e) => {
                if (e.target.classList.contains('skill-node')) {
                    const skill = JSON.parse(e.target.getAttribute('data-skill'));
                    this.showSkillDetails(skill);
                }
            });
        }

        showSkillDetails(skill) {
            this.detailsContainer.innerHTML = `
                <div class="skill-detail-card">
                    <div class="skill-header">
                        <h4 style="color: ${skill.color}; margin: 0;">${skill.name}</h4>
                        <span class="skill-category badge">${skill.category}</span>
                    </div>
                    <div class="skill-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${skill.level}%; background: ${skill.color};"></div>
                        </div>
                        <span class="skill-percentage">${skill.level}%</span>
                    </div>
                    <p class="skill-description">
                        ${this.getSkillDescription(skill.name)}
                    </p>
                </div>
            `;
        }

        getSkillDescription(skillName) {
            const descriptions = {
                'Python': 'Advanced proficiency in Python for data science, AI/ML, and backend development.',
                'Machine Learning': 'Extensive experience in ML algorithms, model training, and deployment.',
                'NLP': 'Natural Language Processing expert with transformer models and LLMs.',
                'LangChain': 'Building RAG applications and LLM-powered solutions.',
                'Google Cloud': 'Vertex AI, BigQuery, and cloud-native AI solutions.',
                'Neo4j': 'Graph database expertise for knowledge graphs and relationship modeling.',
                'React': 'Modern frontend development with hooks, context, and performance optimization.',
                'Django': 'Full-stack web development with Django REST framework.',
                'Elasticsearch': 'Search and analytics engine for large-scale data indexing.',
                'Docker': 'Containerization and microservices architecture.',
                'Kubernetes': 'Container orchestration and cloud-native deployments.',
                'TensorFlow': 'Deep learning framework for neural networks and AI models.',
                'PyTorch': 'Research-oriented deep learning and model experimentation.',
                'JavaScript': 'Modern ES6+ development for interactive web applications.',
                'SQL': 'Database design, optimization, and complex query development.'
            };
            return descriptions[skillName] || 'Proficient in this technology with hands-on experience.';
        }

        // Advanced reactive features
        startAnimation() {
            this.animate();
        }

        animate() {
            this.updateParticles();
            this.updateSkillPositions();
            this.updateConnections();
            this.animationId = requestAnimationFrame(() => this.animate());
        }

        addMouseTracking() {
            this.container.addEventListener('mousemove', (e) => {
                const rect = this.container.getBoundingClientRect();
                this.mousePosition.x = e.clientX - rect.left;
                this.mousePosition.y = e.clientY - rect.top;
                
                // Create mouse attraction effect
                this.skills.forEach(skill => {
                    const dx = this.mousePosition.x - skill.x;
                    const dy = this.mousePosition.y - skill.y;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    
                    if (distance < 100) {
                        const force = (100 - distance) / 100;
                        skill.vx += dx * force * 0.001;
                        skill.vy += dy * force * 0.001;
                        
                        // Create particle trail
                        if (Math.random() < 0.3) {
                            this.createParticle(skill.x, skill.y, skill.color);
                        }
                    }
                });
            });

            this.container.addEventListener('mouseleave', () => {
                this.resetSkillPositions();
            });
        }

        addKeyboardControls() {
            document.addEventListener('keydown', (e) => {
                if (!this.container.querySelector(':hover')) return;
                
                switch(e.key) {
                    case 'r':
                    case 'R':
                        this.randomizePositions();
                        break;
                    case 'c':
                    case 'C':
                        this.cycleByCategory();
                        break;
                    case 'Escape':
                        this.resetSkillPositions();
                        break;
                    case ' ':
                        e.preventDefault();
                        this.explodeSkills();
                        break;
                }
            });
        }

        updateSkillPositions() {
            this.skills.forEach((skill, index) => {
                // Apply velocity
                skill.x += skill.vx;
                skill.y += skill.vy;
                
                // Apply friction
                skill.vx *= 0.95;
                skill.vy *= 0.95;
                
                // Boundary bounce
                const margin = 30;
                if (skill.x < margin || skill.x > this.width - margin) {
                    skill.vx *= -0.8;
                    skill.x = Math.max(margin, Math.min(this.width - margin, skill.x));
                }
                if (skill.y < margin || skill.y > this.height - margin) {
                    skill.vy *= -0.8;
                    skill.y = Math.max(margin, Math.min(this.height - margin, skill.y));
                }
                
                // Update DOM element position
                const node = this.container.querySelector(`[data-skill*='"${skill.name}"']`);
                if (node) {
                    const size = 20 + (skill.level / 100) * 30;
                    node.style.left = (skill.x - size/2) + 'px';
                    node.style.top = (skill.y - size/2) + 'px';
                    
                    // Add breathing animation
                    const breathe = 1 + Math.sin(Date.now() * 0.003 + index) * 0.1;
                    node.style.transform = `scale(${breathe})`;
                }
            });
        }

        updateConnections() {
            const svg = this.container.querySelector('svg');
            if (!svg) return;
            
            const lines = svg.querySelectorAll('line');
            const connections = [
                [0, 1], [1, 2], [2, 3], [4, 8], [5, 8], [6, 13], [7, 13],
                [11, 12], [1, 11], [1, 12], [9, 10]
            ];
            
            lines.forEach((line, index) => {
                if (connections[index]) {
                    const [i, j] = connections[index];
                    if (this.skills[i] && this.skills[j]) {
                        line.setAttribute('x1', this.skills[i].x);
                        line.setAttribute('y1', this.skills[i].y);
                        line.setAttribute('x2', this.skills[j].x);
                        line.setAttribute('y2', this.skills[j].y);
                        
                        // Dynamic line opacity based on distance
                        const dx = this.skills[i].x - this.skills[j].x;
                        const dy = this.skills[i].y - this.skills[j].y;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        const opacity = Math.max(0.1, Math.min(0.5, 200 / distance));
                        line.setAttribute('stroke', `rgba(255,255,255,${opacity})`);
                    }
                }
            });
        }

        createParticle(x, y, color) {
            const particle = document.createElement('div');
            particle.className = 'skill-particle';
            particle.style.cssText = `
                position: absolute;
                width: 4px;
                height: 4px;
                background: ${color};
                border-radius: 50%;
                left: ${x}px;
                top: ${y}px;
                pointer-events: none;
                box-shadow: 0 0 10px ${color};
                z-index: 5;
            `;
            
            this.container.appendChild(particle);
            
            // Animate particle
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 3;
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            
            let life = 1;
            const animateParticle = () => {
                life -= 0.02;
                if (life <= 0) {
                    particle.remove();
                    return;
                }
                
                const currentX = parseFloat(particle.style.left);
                const currentY = parseFloat(particle.style.top);
                particle.style.left = (currentX + vx) + 'px';
                particle.style.top = (currentY + vy) + 'px';
                particle.style.opacity = life;
                particle.style.transform = `scale(${life})`;
                
                requestAnimationFrame(animateParticle);
            };
            
            requestAnimationFrame(animateParticle);
        }

        updateParticles() {
            // Clean up old particles
            const particles = this.container.querySelectorAll('.skill-particle');
            particles.forEach(particle => {
                if (parseFloat(particle.style.opacity) <= 0) {
                    particle.remove();
                }
            });
        }

        randomizePositions() {
            this.skills.forEach(skill => {
                skill.vx = (Math.random() - 0.5) * 10;
                skill.vy = (Math.random() - 0.5) * 10;
            });
        }

        cycleByCategory() {
            const categories = ['Programming', 'AI/ML', 'Cloud', 'Database', 'Frontend', 'Backend', 'DevOps'];
            const currentTime = Date.now();
            const categoryIndex = Math.floor(currentTime / 2000) % categories.length;
            const targetCategory = categories[categoryIndex];
            
            this.skills.forEach(skill => {
                if (skill.category === targetCategory) {
                    skill.vx += (Math.random() - 0.5) * 5;
                    skill.vy += (Math.random() - 0.5) * 5;
                    this.createParticle(skill.x, skill.y, skill.color);
                }
            });
            
            // Show category highlight
            this.showCategoryHighlight(targetCategory);
        }

        showCategoryHighlight(category) {
            const existing = this.container.querySelector('.category-highlight');
            if (existing) existing.remove();
            
            const highlight = document.createElement('div');
            highlight.className = 'category-highlight';
            highlight.textContent = category;
            highlight.style.cssText = `
                position: absolute;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0,0,0,0.7);
                color: white;
                padding: 10px 20px;
                border-radius: 20px;
                font-weight: bold;
                z-index: 100;
                animation: fadeInOut 2s ease-in-out;
            `;
            
            this.container.appendChild(highlight);
            setTimeout(() => highlight.remove(), 2000);
        }

        explodeSkills() {
            this.skills.forEach(skill => {
                const angle = Math.random() * Math.PI * 2;
                const force = 5 + Math.random() * 10;
                skill.vx = Math.cos(angle) * force;
                skill.vy = Math.sin(angle) * force;
                
                // Create explosion particles
                for (let i = 0; i < 5; i++) {
                    setTimeout(() => {
                        this.createParticle(skill.x, skill.y, skill.color);
                    }, i * 100);
                }
            });
        }

        resetSkillPositions() {
            this.skills.forEach(skill => {
                skill.vx *= 0.8;
                skill.vy *= 0.8;
            });
        }

        addInstructions() {
            const instructions = document.createElement('div');
            instructions.className = 'skills-instructions';
            instructions.innerHTML = `
                <h6>🎮 Interactive Controls</h6>
                <ul>
                    <li><span class="key">🖱️</span> Hover & click skills to explore</li>
                    <li><span class="key">R</span> Randomize positions</li>
                    <li><span class="key">C</span> Cycle by category</li>
                    <li><span class="key">Space</span> Explode constellation</li>
                    <li><span class="key">Esc</span> Reset positions</li>
                </ul>
            `;
            
            this.container.appendChild(instructions);
            
            // Auto-hide after 8 seconds
            setTimeout(() => {
                instructions.classList.add('hidden');
            }, 8000);
            
            // Show on hover
            this.container.addEventListener('mouseenter', () => {
                instructions.classList.remove('hidden');
            });
            
            this.container.addEventListener('mouseleave', () => {
                setTimeout(() => {
                    instructions.classList.add('hidden');
                }, 2000);
            });
        }

        destroy() {
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
            }
        }
    }

    // Initialize everything
    new SimpleNavigation();
    new SimpleTheme();
    new SimpleProjects(projectsData);
    new SimpleContact();
    new SkillsConstellation();
    initTypingEffect();
    initPDFViewer();

    // Simple AOS init if available
    if (typeof AOS !== 'undefined') {
        AOS.init({
            duration: 800,
            once: true
        });
    }

    // Hide loading spinner
    function hideLoadingSpinner() {
        const spinner = document.getElementById('loading-spinner');
        if (spinner) {
            spinner.style.display = 'none';
        }
    }

    // Hide spinner after everything is loaded
    setTimeout(hideLoadingSpinner, 500);
    
    // Also hide spinner on window load as fallback
    window.addEventListener('load', hideLoadingSpinner);
});
