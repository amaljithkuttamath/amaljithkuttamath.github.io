// Main application initialization
document.addEventListener("DOMContentLoaded", function () {
    // Project data
    const projectsData = [
      {
        id: "medicalRAG",
        title: "Medical RAG System",
        description: "Developed a Retrieval-Augmented Generation system for medical records using Google Cloud's Vertex AI and Gemini Pro.",
        categories: ["ai", "nlp"],
        technologies: "Python, Vertex AI, Gemini Pro, LangChain",
        details: "This project involved developing a state-of-the-art Retrieval-Augmented Generation (RAG) system specifically designed for medical records. The system can extract key medical terms, diagnoses, and treatment plans from unstructured text, significantly improving the efficiency of medical data analysis. It leverages Google Cloud's Vertex AI and Gemini Pro for advanced natural language processing capabilities."
      },
      {
        id: "predictiveMaintenance",
        title: "Predictive Maintenance Model",
        description: "Built a machine learning model for predictive maintenance in manufacturing, achieving 95% accuracy in time-to-failure predictions.",
        categories: ["ml"],
        technologies: "Python, Scikit-learn, TensorFlow, Azure ML",
        details: "This project focused on developing a machine learning model to predict equipment failures in a manufacturing setting. By analyzing sensor data and historical maintenance records, the model can predict potential failures before they occur, allowing for proactive maintenance. This resulted in a significant reduction in unplanned downtime and improved overall equipment efficiency."
      },
      {
        id: "sentimentAnalysis",
        title: "Sentiment Analysis for Product Safety",
        description: "Implemented a sentiment analysis system for medical expert records to assess product safety in the pharmaceutical industry.",
        categories: ["nlp"],
        technologies: "Python, NLTK, Transformers, Elasticsearch",
        details: "This project involved creating an advanced sentiment analysis system to evaluate product safety in the pharmaceutical industry. By analyzing medical expert records and reports, the system can identify potential safety concerns and sentiment trends. This helps in early detection of issues and supports informed decision-making in product development and safety monitoring."
      },
      {
        id: "inventoryManagement",
        title: "AI-Powered Inventory Management",
        description: "Developed a web application for inventory management with AI-driven forecasting and optimization features.",
        categories: ["web", "ai"],
        technologies: "React, Django, Python, TensorFlow",
        details: "This project combined web development with AI to create an intelligent inventory management system. The application uses machine learning algorithms to forecast demand, optimize stock levels, and provide insights for better inventory control. It features a user-friendly interface built with React, while the backend uses Django and integrates TensorFlow for AI capabilities."
      },
      {
        id: "anomalyDetection",
        title: "Anomaly Detection System",
        description: "Implemented an advanced anomaly detection system for financial transactions, achieving over 90% accuracy.",
        categories: ["ml"],
        technologies: "Python, Scikit-learn, Pandas, Azure Data Lake",
        details: "This project focused on developing a robust anomaly detection system for financial transactions. Using advanced machine learning techniques, the system can identify unusual patterns or suspicious activities in large volumes of financial data. It achieved over 90% accuracy in detecting anomalies, significantly enhancing fraud detection capabilities and reducing financial risks."
      },
      {
        id: "dataVisualization",
        title: "Interactive Data Visualization Dashboard",
        description: "Created a responsive web dashboard for visualizing complex datasets, improving decision-making processes for clients.",
        categories: ["web"],
        technologies: "D3.js, Vue.js, Node.js, Express",
        details: "This project involved creating an interactive and responsive web dashboard for visualizing complex datasets. Using D3.js for data visualization and Vue.js for the frontend, the dashboard allows users to explore and interact with data in real-time. It features customizable charts, filters, and data exploration tools, significantly improving the decision-making process for clients across various industries."
      }
    ];
  
    // Skills data
    const skillsData = {
      nodes: [
        { id: "AI", group: 1, label: "Artificial Intelligence", level: 95 },
        { id: "ML", group: 1, label: "Machine Learning", level: 90 },
        { id: "DL", group: 1, label: "Deep Learning", level: 88 },
        { id: "NLP", group: 1, label: "Natural Language Processing", level: 92 },
        { id: "CV", group: 1, label: "Computer Vision", level: 85 },
        { id: "RL", group: 1, label: "Reinforcement Learning", level: 80 },
        { id: "NN", group: 1, label: "Neural Networks", level: 90 },
        { id: "TF", group: 1, label: "TensorFlow", level: 88 },
        { id: "PT", group: 1, label: "PyTorch", level: 85 },
        { id: "SKL", group: 1, label: "Scikit-learn", level: 92 },
        { id: "DS", group: 2, label: "Data Science", level: 93 },
        { id: "DA", group: 2, label: "Data Analysis", level: 95 },
        { id: "SM", group: 2, label: "Statistical Modeling", level: 88 },
        { id: "DV", group: 2, label: "Data Visualization", level: 90 },
        { id: "BDP", group: 2, label: "Big Data Processing", level: 85 },
        { id: "PD", group: 2, label: "Pandas", level: 95 },
        { id: "NP", group: 2, label: "NumPy", level: 93 },
        { id: "SP", group: 2, label: "SciPy", level: 90 },
        { id: "MPL", group: 2, label: "Matplotlib", level: 88 },
        { id: "PY", group: 3, label: "Python", level: 98 },
        { id: "R", group: 3, label: "R", level: 85 },
        { id: "SQL", group: 3, label: "SQL", level: 90 },
        { id: "JAVA", group: 3, label: "Java", level: 80 },
        { id: "CPP", group: 3, label: "C++", level: 75 },
        { id: "JS", group: 3, label: "JavaScript", level: 85 },
        { id: "GIT", group: 4, label: "Git", level: 92 },
        { id: "DOCKER", group: 4, label: "Docker", level: 88 },
        { id: "K8S", group: 4, label: "Kubernetes", level: 80 },
        { id: "AWS", group: 4, label: "AWS", level: 85 },
        { id: "GCP", group: 4, label: "Google Cloud Platform", level: 90 },
        { id: "JN", group: 4, label: "Jupyter Notebooks", level: 95 },
        { id: "SPARK", group: 4, label: "Apache Spark", level: 82 },
        { id: "MONGO", group: 4, label: "MongoDB", level: 85 }
      ],
      links: [
        { source: "AI", target: "ML", value: 1 },
        { source: "AI", target: "DL", value: 1 },
        { source: "AI", target: "NLP", value: 1 },
        { source: "AI", target: "CV", value: 1 },
        { source: "ML", target: "DL", value: 1 },
        { source: "ML", target: "NN", value: 1 },
        { source: "DL", target: "NN", value: 1 },
        { source: "NLP", target: "DL", value: 1 },
        { source: "CV", target: "DL", value: 1 },
        { source: "RL", target: "ML", value: 1 },
        { source: "TF", target: "DL", value: 1 },
        { source: "PT", target: "DL", value: 1 },
        { source: "SKL", target: "ML", value: 1 },
        { source: "DS", target: "DA", value: 1 },
        { source: "DS", target: "SM", value: 1 },
        { source: "DS", target: "DV", value: 1 },
        { source: "DS", target: "BDP", value: 1 },
        { source: "DA", target: "PD", value: 1 },
        { source: "DA", target: "NP", value: 1 },
        { source: "SM", target: "SP", value: 1 },
        { source: "DV", target: "MPL", value: 1 },
        { source: "PY", target: "ML", value: 1 },
        { source: "PY", target: "DS", value: 1 },
        { source: "R", target: "DS", value: 1 },
        { source: "SQL", target: "DA", value: 1 },
        { source: "GIT", target: "PY", value: 1 },
        { source: "DOCKER", target: "ML", value: 1 },
        { source: "K8S", target: "DOCKER", value: 1 },
        { source: "AWS", target: "ML", value: 1 },
        { source: "GCP", target: "ML", value: 1 },
        { source: "JN", target: "PY", value: 1 },
        { source: "SPARK", target: "BDP", value: 1 },
        { source: "MONGO", target: "DA", value: 1 }
      ]
    };
  
    // Utility functions
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
      },
  
      throttle: (func, limit) => {
        let inThrottle;
        return function executedFunction(...args) {
          if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
          }
        };
      },
  
      observeElement: (element, callback, options = {}) => {
        const observer = new IntersectionObserver(callback, options);
        if (element) observer.observe(element);
        return observer;
      }
    };
  
    // Navigation and scroll handling
    class Navigation {
      constructor() {
        this.initSmoothScroll();
        this.initBackToTop();
        this.initScrollSpy();
      }
  
      initSmoothScroll() {
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
          anchor.addEventListener("click", (e) => {
            e.preventDefault();
            const target = document.querySelector(anchor.getAttribute("href"));
            target?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });
      }
  
      initBackToTop() {
        const backToTop = document.getElementById("backToTop");
        if (!backToTop) return;
  
        const handleScroll = utils.throttle(() => {
          backToTop.style.display = window.pageYOffset > 300 ? "block" : "none";
        }, 100);
  
        window.addEventListener("scroll", handleScroll, { passive: true });
        backToTop.addEventListener("click", () => {
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      }
  
      initScrollSpy() {
        const sections = document.querySelectorAll(".section");
        const navLinks = document.querySelectorAll(".nav-link");
  
        const handleScroll = utils.throttle(() => {
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
        }, 100);
  
        window.addEventListener("scroll", handleScroll, { passive: true });
      }
    }
  
    // Theme handling
    class ThemeManager {
      constructor() {
        this.darkModeToggle = document.getElementById("darkModeToggle");
        this.body = document.body;
        this.init();
      }
  
      init() {
        if (!this.darkModeToggle) return;
  
        const savedDarkMode = localStorage.getItem("darkMode") === "true";
        this.toggleDarkMode(savedDarkMode);
  
        this.darkModeToggle.addEventListener("click", () => {
          this.toggleDarkMode(!this.body.classList.contains("dark-mode"));
        });
      }
  
      toggleDarkMode(isDark) {
        this.body.classList.toggle("dark-mode", isDark);
        this.darkModeToggle.innerHTML = isDark ? 
          '<i class="fas fa-sun"></i>' : 
          '<i class="fas fa-moon"></i>';
        localStorage.setItem("darkMode", isDark);
      }
    }
  
    // Skills visualization
    class SkillsGraph {
      constructor(data) {
        this.data = data;
        this.container = document.getElementById("skills-graph");
        this.init();
      }
  
      init() {
        if (!this.container) return;
  
        utils.observeElement(this.container, (entries, observer) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              this.render();
              observer.unobserve(entry.target);
            }
          });
        });
      }
  
      render() {
        const width = this.container.clientWidth;
        const height = 600;
  
        const svg = d3.select("#skills-graph")
          .append("svg")
          .attr("viewBox", [0, 0, width, height])
          .attr("style", "max-width: 100%; height: auto;");
  
        // Create simulation
        const simulation = d3.forceSimulation(this.data.nodes)
          .force("link", d3.forceLink(this.data.links).id(d => d.id))
          .force("charge", d3.forceManyBody().strength(-200))
          .force("center", d3.forceCenter(width / 2, height / 2));
  
        // Add links
        const link = svg.append("g")
          .selectAll("line")
          .data(this.data.links)
          .join("line")
          .attr("stroke", "#999")
          .attr("stroke-opacity", 0.6);
  
        // Add nodes
        const node = svg.append("g")
          .selectAll("g")
          .data(this.data.nodes)
          .join("g")
          .call(this.drag(simulation));
  
        // Add circles to nodes
        node.append("circle")
          .attr("r", d => d.level / 4)
          .attr("fill", d => d3.schemeCategory10[d.group - 1]);
  
        // Add labels to nodes
        node.append("text")
          .attr("dx", d => d.level / 4 + 5)
          .attr("dy", ".35em")
          .text(d => d.id)
          .style("font-size", "12px");
  
        // Update positions on tick
        simulation.on("tick", () => {
          link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);
  
          node
            .attr("transform", d => `translate(${d.x},${d.y})`);
        });
      }
  
      drag(simulation) {
        function dragstarted(event) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        }
  
        function dragged(event) {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        }
  
        function dragended(event) {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        }
  
        return d3.drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended);
      }
    }
  
    // Projects management
    class ProjectsManager {
      constructor(projects) {
        this.projects = projects;
        this.container = document.getElementById("projectsList");
        this.filterButtons = document.querySelectorAll(".project-filter");
        this.modal = document.getElementById("projectModal");
        this.init();
      }
  
      init() {
        if (!this.container) return;
  
        this.renderProjects("all");
        this.initFilters();
        this.initModal();
      }
  
      renderProjects(category) {
        const filteredProjects = category === "all" 
          ? this.projects 
          : this.projects.filter(project => project.categories.includes(category));
  
        this.container.innerHTML = filteredProjects.map(project => `
          <div class="col-md-6 col-lg-4 mb-4">
            <div class="card h-100">
              <div class="card-body">
                <h5 class="card-title">${project.title}</h5>
                <p class="card-text">${project.description}</p>
                <p class="tech-stack">${project.technologies}</p>
                <button class="btn btn-primary" data-bs-toggle="modal" 
                        data-bs-target="#projectModal" data-project="${project.id}">
                  Learn More
                </button>
              </div>
            </div>
          </div>
        `).join('');
      }
  
      initFilters() {
        this.filterButtons.forEach(button => {
          button.addEventListener("click", () => {
            const category = button.getAttribute("data-filter");
            this.filterButtons.forEach(btn => btn.classList.remove("active"));
            button.classList.add("active");
            this.renderProjects(category);
          });
        });
      }
  
      initModal() {
        if (!this.modal) return;
  
        this.modal.addEventListener("show.bs.modal", (event) => {
          const button = event.relatedTarget;
          const projectId = button.getAttribute("data-project");
          const project = this.projects.find(p => p.id === projectId);
          
          if (project) {
            this.modal.querySelector(".modal-title").textContent = project.title;
            this.modal.querySelector(".modal-body").innerHTML = `
              <p>${project.details}</p>
              <p><strong>Technologies:</strong> ${project.technologies}</p>
              <p><strong>Categories:</strong> ${project.categories.join(", ")}</p>
            `;
          }
        });
      }
    }
  
    // Contact form handling
    class ContactForm {
      constructor() {
        this.form = document.getElementById("contactForm");
        this.init();
      }
  
      init() {
        if (!this.form) return;
  
        this.form.addEventListener("submit", async (e) => {
          e.preventDefault();
          
          if (!this.form.checkValidity()) {
            this.form.classList.add("was-validated");
            return;
          }
  
          try {
            // Here you would typically send the form data to your backend
            const formData = new FormData(this.form);
            // await this.sendFormData(formData);
            
            alert("Thank you for your message! I will get back to you soon.");
            this.form.reset();
            this.form.classList.remove("was-validated");
          } catch (error) {
            console.error("Form submission error:", error);
            alert("There was an error sending your message. Please try again.");
          }
        });
      }
  
      async sendFormData(formData) {
        // Implement your form submission logic here
        // const response = await fetch('/api/contact', {
        //   method: 'POST',
        //   body: formData
        // });
        // return response.json();
      }
    }
  
    // Animation handling
    class AnimationManager {
      constructor() {
        this.initTypingEffect();
        this.initScrollAnimations();
      }
  
      initTypingEffect() {
        const element = document.getElementById("typing-effect");
        if (!element) return;
  
        new Typed(element, {
          strings: ["AI Engineer", "NLP Researcher", "Faculty @GMU"],
          typeSpeed: 50,
          backSpeed: 30,
          loop: true,
          smartBackspace: true
        });
      }
  
      initScrollAnimations() {
        AOS.init({
          duration: 1000,
          once: true,
          mirror: false
        });
  
        const handleScroll = utils.throttle(() => {
          const scrollY = window.scrollY;
          const windowHeight = window.innerHeight;
  
          document.querySelectorAll(".section").forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.offsetHeight;
  
            if (scrollY > sectionTop - windowHeight / 2 && 
                scrollY < sectionTop + sectionHeight - windowHeight / 2) {
              section.classList.add("active");
            } else {
              section.classList.remove("active");
            }
          });
        }, 100);
  
        window.addEventListener("scroll", handleScroll, { passive: true });
      }
    }
  
    // Initialize all components
    function initializeApp() {
      window.projectsData = projectsData; // Make projects data globally available
      
      new Navigation();
      new ThemeManager();
      new SkillsGraph(skillsData);
      new ProjectsManager(projectsData);
      new ContactForm();
      new AnimationManager();
    }
  
    // Start the application
    initializeApp();
  });
