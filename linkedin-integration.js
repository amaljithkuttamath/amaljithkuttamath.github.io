// LinkedIn Integration
class LinkedInIntegration {
    constructor() {
        this.recommendationsContainer = document.getElementById('recommendations-container');
        this.initialize();
    }

    initialize() {
        // Sample recommendations data (replace with actual LinkedIn API integration)
        const recommendations = [
            {
                name: "John Smith",
                title: "Senior AI Engineer at Tech Corp",
                avatar: "https://ui-avatars.com/api/?name=John+Smith",
                text: "Amaljith is an exceptional AI engineer with deep expertise in NLP and machine learning. His ability to solve complex problems and deliver innovative solutions is remarkable."
            },
            {
                name: "Sarah Johnson",
                title: "Lead Data Scientist at AI Solutions",
                avatar: "https://ui-avatars.com/api/?name=Sarah+Johnson",
                text: "Working with Amaljith was a great experience. His knowledge of healthcare analytics and machine learning is impressive, and he consistently delivers high-quality results."
            },
            {
                name: "Michael Chen",
                title: "CTO at HealthTech Innovations",
                avatar: "https://ui-avatars.com/api/?name=Michael+Chen",
                text: "Amaljith's contributions to our healthcare AI projects were invaluable. His expertise in NLP and knowledge graphs helped us achieve breakthrough results in medical data analysis."
            }
        ];

        this.displayRecommendations(recommendations);

        // LinkedIn API Integration (when API key is configured)
        if (typeof IN !== 'undefined') {
            IN.Event.on(IN, "auth", () => {
                this.fetchLinkedInRecommendations();
            });
        }
    }

    displayRecommendations(recommendations) {
        if (!this.recommendationsContainer) return;

        this.recommendationsContainer.innerHTML = recommendations.map(rec => `
            <div class="recommendation-card" data-aos="fade-up">
                <div class="recommendation-header">
                    <img src="${rec.avatar}" alt="${rec.name}" class="recommender-avatar">
                    <div class="recommender-info">
                        <h4 class="recommender-name">${rec.name}</h4>
                        <p class="recommender-title">${rec.title}</p>
                    </div>
                </div>
                <p class="recommendation-text">${rec.text}</p>
            </div>
        `).join('');
    }

    async fetchLinkedInRecommendations() {
        try {
            // This is a placeholder for actual LinkedIn API integration
            // Replace with actual API calls when API key is configured
            IN.API.Profile("me").fields([
                "recommendations-received:(recommender,recommendation-text)"
            ]).result(response => {
                const recommendations = response.values[0].recommendationsReceived.values.map(rec => ({
                    name: `${rec.recommender.firstName} ${rec.recommender.lastName}`,
                    title: rec.recommender.headline,
                    avatar: rec.recommender.pictureUrl || `https://ui-avatars.com/api/?name=${rec.recommender.firstName}+${rec.recommender.lastName}`,
                    text: rec.recommendationText
                }));
                this.displayRecommendations(recommendations);
            });
        } catch (error) {
            console.error('Error fetching LinkedIn recommendations:', error);
            // Fallback to sample recommendations if API fails
            this.displayRecommendations(this.sampleRecommendations);
        }
    }
}

// Initialize LinkedIn integration when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new LinkedInIntegration();
});

// Add LinkedIn API error handling
window.onerror = function(msg, url, lineNo, columnNo, error) {
    if (msg.includes('LinkedIn')) {
        console.warn('LinkedIn API not properly configured. Using sample recommendations instead.');
        return false;
    }
    return false;
};
