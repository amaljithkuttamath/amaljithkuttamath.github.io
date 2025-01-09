document.addEventListener("DOMContentLoaded", function () {
  // Debounce function
  function debounce(func, wait) {
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

  // Improved dark mode handling
  const darkModeToggle = document.getElementById("darkModeToggle");
  const prefersDarkScheme = window.matchMedia("(prefers-color-scheme: dark)");

  function setDarkMode(isDark) {
    document.body.classList.toggle("dark-mode", isDark);
    darkModeToggle.innerHTML = isDark
      ? '<i class="fas fa-sun"></i>'
      : '<i class="fas fa-moon"></i>';
    localStorage.setItem("darkMode", isDark);
  }

  // Initialize dark mode based on user preference or saved setting
  const savedDarkMode = localStorage.getItem("darkMode");
  setDarkMode(
    savedDarkMode === null ? prefersDarkScheme.matches : savedDarkMode === "true"
  );

  document.querySelectorAll('a[href^="#"]').forEach((e) => {
    e.addEventListener("click", function (e) {
      e.preventDefault();
      const t = document.querySelector(this.getAttribute("href"));
      t && t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  new Typed("#typing-effect", {
    strings: ["AI Engineer", "NLP Researcher", "Faculty @GMU"],
    typeSpeed: 50,
    backSpeed: 30,
    loop: !0,
    smartBackspace: !0,
  });
  AOS.init({ duration: 1e3, once: !0, mirror: !1 });
  const e = document.getElementById("darkModeToggle"),
    t = document.body;
  function a(a) {
    t.classList.toggle("dark-mode", a),
      (e.innerHTML = a
        ? '<i class="fas fa-sun"></i>'
        : '<i class="fas fa-moon"></i>'),
      localStorage.setItem("darkMode", a);
  }
  a("true" === localStorage.getItem("darkMode")),
    e.addEventListener("click", () => {
      a(!t.classList.contains("dark-mode"));
    });
  const i = document.getElementById("backToTop");
  const handleScroll = debounce(() => {
    const scrollPosition = window.pageYOffset;
    document.getElementById("backToTop").style.display =
      scrollPosition > 300 ? "block" : "none";

    document.querySelectorAll(".section").forEach((section) => {
      const rect = section.getBoundingClientRect();
      const isVisible =
        rect.top < window.innerHeight / 2 && rect.bottom >= window.innerHeight / 2;
      section.classList.toggle("active", isVisible);
    });
  }, 100);

  window.addEventListener("scroll", handleScroll);

  const n = [
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
      { id: "MONGO", group: 4, label: "MongoDB", level: 85 },
    ],
    o = [
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
      { source: "MONGO", target: "DA", value: 1 },
    ],
    r = new IntersectionObserver((e, t) => {
      e.forEach((e) => {
        e.isIntersecting &&
          (!(function () {
            const e = s.clientWidth,
              t = 600,
              a = d3
                .select("#skills-graph")
                .append("svg")
                .attr("width", e)
                .attr("height", t)
                .attr("viewBox", [0, 0, e, t])
                .attr("style", "max-width: 100%; height: auto;"),
              i = d3.zoom().scaleExtent([0.5, 3]).on("zoom", l);
            a.call(i);
            const r = a.append("g");
            function l(e) {
              r.attr("transform", e.transform);
            }
            const c = d3
                .forceSimulation(n)
                .force(
                  "link",
                  d3
                    .forceLink(o)
                    .id((e) => e.id)
                    .distance(100)
                )
                .force("charge", d3.forceManyBody().strength(-200))
                .force("center", d3.forceCenter(e / 2, t / 2))
                .force(
                  "collision",
                  d3.forceCollide().radius((e) => e.level / 2 + 10)
                ),
              d = r
                .append("g")
                .selectAll("line")
                .data(o)
                .join("line")
                .attr("stroke", "#999")
                .attr("stroke-opacity", 0.6)
                .attr("stroke-width", (e) => Math.sqrt(e.value)),
              g = r
                .append("g")
                .selectAll("g")
                .data(n)
                .join("g")
                .call(d3.drag().on("start", u).on("drag", p).on("end", m))
                .on("mouseover", f)
                .on("mouseout", h)
                .on("click", v);
            function u(e) {
              e.active || c.alphaTarget(0.3).restart(),
                (e.subject.fx = e.subject.x),
                (e.subject.fy = e.subject.y);
            }
            function p(e) {
              (e.subject.fx = e.x), (e.subject.fy = e.y);
            }
            function m(e) {
              e.active || c.alphaTarget(0),
                (e.subject.fx = null),
                (e.subject.fy = null);
            }
            function f(e, t) {
              const a = o.reduce(
                (e, a) => (
                  (a.source !== t && a.target !== t) ||
                    (e.add(a.source.id || a.source),
                    e.add(a.target.id || a.target)),
                  e
                ),
                new Set()
              );
              g.style("opacity", (e) => (a.has(e.id) ? 1 : 0.1)),
                d.style("opacity", (e) =>
                  e.source === t || e.target === t ? 1 : 0.1
                );
            }
            function h() {
              g.style("opacity", 1), d.style("opacity", 1);
            }
            function v(e, t) {
              const a = d3.select("#skill-details"),
                i = {
                  1: "AI/Machine Learning",
                  2: "Data Science",
                  3: "Programming Languages",
                  4: "Tools & Technologies",
                }[t.group];
              let r = o
                .filter((e) => e.source === t || e.target === t)
                .map((e) => (e.source === t ? e.target : e.source))
                .map((e) => e.label || n.find((t) => t.id === e).label)
                .join(", ");
              var s;
              a.html(
                `\n                <h4>${
                  t.label
                }</h4>\n                <p><strong>Skill Level:</strong> ${
                  t.level
                }%</p>\n                <p><strong>Category:</strong> ${i}</p>\n                <p><strong>Related Skills:</strong> ${r}</p>\n                <p><strong>Description:</strong> ${
                  ((s = t.id),
                  {
                    AI: "Artificial Intelligence is the simulation of human intelligence processes by machines, especially computer systems.",
                    ML: "Machine Learning is a subset of AI that provides systems the ability to automatically learn and improve from experience without being explicitly programmed.",
                    DL: "Deep Learning is part of a broader family of machine learning methods based on artificial neural networks with representation learning.",
                    NLP: "Natural Language Processing is a subfield of linguistics, computer science, and artificial intelligence concerned with the interactions between computers and human language.",
                    CV: "Computer Vision is an interdisciplinary scientific field that deals with how computers can gain high-level understanding from digital images or videos.",
                    RL: "Reinforcement Learning is an area of machine learning concerned with how software agents ought to take actions in an environment so as to maximize some notion of cumulative reward.",
                    NN: "Neural Networks are computing systems vaguely inspired by the biological neural networks that constitute animal brains.",
                    TF: "TensorFlow is a free and open-source software library for machine learning and artificial intelligence.",
                    PT: "PyTorch is an open source machine learning library based on the Torch library, used for applications such as computer vision and natural language processing.",
                    SKL: "Scikit-learn is a free software machine learning library for the Python programming language.",
                    DS: "Data Science is an interdisciplinary field that uses scientific methods, processes, algorithms and systems to extract knowledge and insights from structured and unstructured data.",
                    DA: "Data Analysis is a process of inspecting, cleansing, transforming, and modeling data with the goal of discovering useful information, informing conclusions, and supporting decision-making.",
                    SM: "Statistical Modeling involves formulating mathematical models to represent data and draw inferences.",
                    DV: "Data Visualization is the graphic representation of data to interactively and efficiently convey insights to a target audience.",
                    BDP: "Big Data Processing involves handling vast volumes of data using specialized tools and techniques.",
                    PD: "Pandas is a software library written for the Python programming language for data manipulation and analysis.",
                    NP: "NumPy is a library for the Python programming language, adding support for large, multi-dimensional arrays and matrices, along with a large collection of high-level mathematical functions to operate on these arrays.",
                    SP: "SciPy is a free and open-source Python library used for scientific computing and technical computing.",
                    MPL: "Matplotlib is a plotting library for the Python programming language and its numerical mathematics extension NumPy.",
                    PY: "Python is an interpreted, high-level and general-purpose programming language, widely used in data science and machine learning.",
                    R: "R is a programming language and free software environment for statistical computing and graphics.",
                    SQL: "SQL (Structured Query Language) is a domain-specific language used in programming and designed for managing data held in a relational database management system.",
                    JAVA: "Java is a class-based, object-oriented programming language that is designed to have as few implementation dependencies as possible.",
                    CPP: "C++ is a general-purpose programming language created by Bjarne Stroustrup as an extension of the C programming language.",
                    JS: "JavaScript is a programming language that conforms to the ECMAScript specification, often used for web development.",
                    GIT: "Git is a distributed version-control system for tracking changes in source code during software development.",
                    DOCKER:
                      "Docker is a set of platform as a service products that use OS-level virtualization to deliver software in packages called containers.",
                    K8S: "Kubernetes is an open-source container-orchestration system for automating computer application deployment, scaling, and management.",
                    AWS: "Amazon Web Services is a subsidiary of Amazon providing on-demand cloud computing platforms and APIs to individuals, companies, and governments.",
                    GCP: "Google Cloud Platform is a suite of cloud computing services that runs on the same infrastructure that Google uses internally for its end-user products.",
                    JN: "Jupyter Notebook is an open-source web application that allows you to create and share documents that contain live code, equations, visualizations and narrative text.",
                    SPARK:
                      "Apache Spark is an open-source unified analytics engine for large-scale data processing.",
                    MONGO:
                      "MongoDB is a source-available cross-platform document-oriented database program, classified as a NoSQL database program.",
                  }[s] || "No description available.")
                }</p>\n            `
              ),
                a.style("display", "block");
            }
            g
              .append("circle")
              .attr("r", (e) => e.level / 4)
              .attr("fill", (e) => d3.schemeCategory10[e.group - 1]),
              g
                .append("text")
                .attr("dy", ".35em")
                .attr("x", (e) => e.level / 4 + 5)
                .attr("text-anchor", "start")
                .text((e) => e.id)
                .style("font-size", "10px")
                .style("fill", "#333"),
              g.append("title").text((e) => `${e.label} (${e.level}%)`),
              c.on("tick", () => {
                d
                  .attr("x1", (e) => e.source.x)
                  .attr("y1", (e) => e.source.y)
                  .attr("x2", (e) => e.target.x)
                  .attr("y2", (e) => e.target.y),
                  g.attr("transform", (e) => `translate(${e.x},${e.y})`);
              });
            const y = a
                .append("g")
                .attr("transform", `translate(${e - 150}, 20)`),
              b = [
                { color: d3.schemeCategory10[0], label: "AI/ML" },
                { color: d3.schemeCategory10[1], label: "Data Science" },
                { color: d3.schemeCategory10[2], label: "Programming" },
                { color: d3.schemeCategory10[3], label: "Tools & Tech" },
              ];
            y
              .selectAll("rect")
              .data(b)
              .enter()
              .append("rect")
              .attr("x", 0)
              .attr("y", (e, t) => 20 * t)
              .attr("width", 10)
              .attr("height", 10)
              .attr("fill", (e) => e.color),
              y
                .selectAll("text")
                .data(b)
                .enter()
                .append("text")
                .attr("x", 15)
                .attr("y", (e, t) => 20 * t + 9)
                .text((e) => e.label)
                .style("font-size", "12px")
                .attr("alignment-baseline", "middle");
          })(),
          t.unobserve(e.target));
      });
    }),
    s = document.getElementById("skills-graph");
  r.observe(s);
  const l = document.getElementById("contactForm");
  l.addEventListener("submit", async function (e) {
    e.preventDefault();
    try {
      // Add your form submission logic here
      const response = await submitForm(this);
      if (!response.ok) throw new Error("Form submission failed");
      alert("Thank you for your message!");
      this.reset();
    } catch (error) {
      console.error("Form submission error:", error);
      alert(
        "Sorry, there was an error sending your message. Please try again later."
      );
    }
    this.classList.add("was-validated");
  });
  const c = [
    {
      id: "medicalRAG",
      title: "Medical RAG System",
      description:
        "Developed a Retrieval-Augmented Generation system for medical records using Google Cloud's Vertex AI and Gemini Pro.",
      categories: ["ai", "nlp"],
      technologies: "Python, Vertex AI, Gemini Pro, LangChain",
      details:
        "This project involved developing a state-of-the-art Retrieval-Augmented Generation (RAG) system specifically designed for medical records. The system can extract key medical terms, diagnoses, and treatment plans from unstructured text, significantly improving the efficiency of medical data analysis. It leverages Google Cloud's Vertex AI and Gemini Pro for advanced natural language processing capabilities.",
    },
    {
      id: "predictiveMaintenance",
      title: "Predictive Maintenance Model",
      description:
        "Built a machine learning model for predictive maintenance in manufacturing, achieving 95% accuracy in time-to-failure predictions.",
      categories: ["ml"],
      technologies: "Python, Scikit-learn, TensorFlow, Azure ML",
      details:
        "This project focused on developing a machine learning model to predict equipment failures in a manufacturing setting. By analyzing sensor data and historical maintenance records, the model can predict potential failures before they occur, allowing for proactive maintenance. This resulted in a significant reduction in unplanned downtime and improved overall equipment efficiency.",
    },
    {
      id: "sentimentAnalysis",
      title: "Sentiment Analysis for Product Safety",
      description:
        "Implemented a sentiment analysis system for medical expert records to assess product safety in the pharmaceutical industry.",
      categories: ["nlp"],
      technologies: "Python, NLTK, Transformers, Elasticsearch",
      details:
        "This project involved creating an advanced sentiment analysis system to evaluate product safety in the pharmaceutical industry. By analyzing medical expert records and reports, the system can identify potential safety concerns and sentiment trends. This helps in early detection of issues and supports informed decision-making in product development and safety monitoring.",
    },
    {
      id: "inventoryManagement",
      title: "AI-Powered Inventory Management",
      description:
        "Developed a web application for inventory management with AI-driven forecasting and optimization features.",
      categories: ["web", "ai"],
      technologies: "React, Django, Python, TensorFlow",
      details:
        "This project combined web development with AI to create an intelligent inventory management system. The application uses machine learning algorithms to forecast demand, optimize stock levels, and provide insights for better inventory control. It features a user-friendly interface built with React, while the backend uses Django and integrates TensorFlow for AI capabilities.",
    },
    {
      id: "anomalyDetection",
      title: "Anomaly Detection System",
      description:
        "Implemented an advanced anomaly detection system for financial transactions, achieving over 90% accuracy.",
      categories: ["ml"],
      technologies: "Python, Scikit-learn, Pandas, Azure Data Lake",
      details:
        "This project focused on developing a robust anomaly detection system for financial transactions. Using advanced machine learning techniques, the system can identify unusual patterns or suspicious activities in large volumes of financial data. It achieved over 90% accuracy in detecting anomalies, significantly enhancing fraud detection capabilities and reducing financial risks.",
    },
    {
      id: "dataVisualization",
      title: "Interactive Data Visualization Dashboard",
      description:
        "Created a responsive web dashboard for visualizing complex datasets, improving decision-making processes for clients.",
      categories: ["web"],
      technologies: "D3.js, Vue.js, Node.js, Express",
      details:
        "This project involved creating an interactive and responsive web dashboard for visualizing complex datasets. Using D3.js for data visualization and Vue.js for the frontend, the dashboard allows users to explore and interact with data in real-time. It features customizable charts, filters, and data exploration tools, significantly improving the decision-making process for clients across various industries.",
    },
  ];
  !(function (e) {
    const t = document.getElementById("projectsList");
    (t.innerHTML = ""),
      e.forEach((e) => {
        const a = document.createElement("div");
        (a.className = "col-md-6 col-lg-4 mb-4"),
          a.setAttribute("data-category", e.categories.join(" ")),
          (a.innerHTML = `\n                <div class="card h-100">\n                    <div class="card-body">\n                        <h5 class="card-title">${e.title}</h5>\n                        <p class="card-text">${e.description}</p>\n                        <p><strong>Technologies:</strong> ${e.technologies}</p>\n                        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#projectModal" data-project="${e.id}">Learn More</button>\n                    </div>\n                </div>\n            `),
          t.appendChild(a);
      });
  })(c);
  const d = document.querySelectorAll(".btn-group button");
  d.forEach((e) => {
    e.addEventListener("click", function () {
      const e = this.getAttribute("data-filter");
      d.forEach((e) => e.classList.remove("active")),
        this.classList.add("active");
      document.querySelectorAll("#projectsList > div").forEach((t) => {
        "all" === e || t.getAttribute("data-category").includes(e)
          ? (t.style.display = "")
          : (t.style.display = "none");
      });
    });
  });
  const g = document.getElementById("projectModal");
  g.addEventListener("show.bs.modal", function (e) {
    const t = e.relatedTarget.getAttribute("data-project"),
      a = c.find((e) => e.id === t),
      i = g.querySelector(".modal-title"),
      n = g.querySelector(".modal-body");
    (i.textContent = a.title),
      (n.innerHTML = `\n            <p>${
        a.details
      }</p>\n            <p><strong>Technologies:</strong> ${
        a.technologies
      }</p>\n            <p><strong>Categories:</strong> ${a.categories.join(
        ", "
      )}</p>\n        `);
  }),
    window.addEventListener("scroll", handleScroll);
});

function initializeNetwork(container) {
    const width = container.clientWidth;
    const height = 600;
    let currentScale = 1;
    
    // Add UI controls
    container.insertAdjacentHTML('beforeend', `
        <div class="network-controls-container">
            <input type="text" class="form-control network-search" placeholder="Search skills...">
            <div class="network-controls">
                <button class="btn btn-sm btn-light" id="zoomIn"><i class="fas fa-plus"></i></button>
                <button class="btn btn-sm btn-light" id="zoomOut"><i class="fas fa-minus"></i></button>
                <button class="btn btn-sm btn-light" id="resetView"><i class="fas fa-undo"></i></button>
                <button class="btn btn-sm btn-light" id="togglePhysics"><i class="fas fa-atom"></i></button>
            </div>
        </div>
    `);

    // Setup visualization
    const svg = d3.select(container)
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const g = svg.append('g');
    
    // Setup zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.2, 4])
        .on('zoom', ({transform}) => {
            currentScale = transform.k;
            g.attr('transform', transform);
            updateNodesScale();
        });

    svg.call(zoom);

    // Initialize simulation
    const simulation = d3.forceSimulation(n)
        .force('link', d3.forceLink(o).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.level / 2 + 10));

    // Create network elements
    const links = g.append('g')
        .selectAll('path')
        .data(o)
        .join('path')
        .attr('stroke', '#999')
        .attr('stroke-opacity', 0.6)
        .attr('fill', 'none');

    const nodes = g.append('g')
        .selectAll('g')
        .data(n)
        .join('g')
        .call(d3.drag()
            .on('start', (e) => {
                if (!e.active) simulation.alphaTarget(0.3).restart();
                e.subject.fx = e.subject.x;
                e.subject.fy = e.subject.y;
            })
            .on('drag', (e) => {
                e.subject.fx = e.x;
                e.subject.fy = e.y;
            })
            .on('end', (e) => {
                if (!e.active) simulation.alphaTarget(0);
                e.subject.fx = null;
                e.subject.fy = null;
            }));

    // Add visual elements to nodes
    nodes.append('circle')
        .attr('r', d => d.level / 4)
        .attr('fill', d => d3.schemeCategory10[d.group - 1]);

    nodes.append('text')
        .attr('x', d => d.level / 4 + 5)
        .attr('dy', '.35em')
        .text(d => d.id);

    // Event handlers
    document.querySelector('.network-search').addEventListener('input', e => {
        const term = e.target.value.toLowerCase();
        const nodeOpacity = d => d.label.toLowerCase().includes(term) ? 1 : 0.1;
        const linkOpacity = d => d.source.label.toLowerCase().includes(term) ||
            d.target.label.toLowerCase().includes(term) ? 0.6 : 0.1;
        nodes.style('opacity', nodeOpacity);
        links.style('opacity', linkOpacity);
    });

    // Control buttons
    document.getElementById('zoomIn').onclick = () => svg.transition().call(zoom.scaleBy, 1.3);
    document.getElementById('zoomOut').onclick = () => svg.transition().call(zoom.scaleBy, 0.7);
    document.getElementById('resetView').onclick = () => svg.transition().call(zoom.transform, d3.zoomIdentity);
    document.getElementById('togglePhysics').onclick = () => 
        simulation.alpha() > 0 ? simulation.stop() : simulation.restart();

    function updateNodesScale() {
        nodes.selectAll('circle').attr('r', d => (d.level / 4) / currentScale);
        nodes.selectAll('text')
            .style('font-size', `${12 / currentScale}px`)
            .attr('x', d => (d.level / 4 + 5) / currentScale);
    }

    // Update positions
    simulation.on('tick', () => {
        links.attr('d', d => {
            const dx = d.target.x - d.source.x,
                  dy = d.target.y - d.source.y,
                  dr = Math.sqrt(dx * dx + dy * dy);
            return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
        });
        nodes.attr('transform', d => `translate(${d.x},${d.y})`);
    });
}
