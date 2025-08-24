(function() {
    class WhatsAppWidget {
        constructor(config) {
            this.config = {
                phoneNumber: '',
                defaultMessage: 'Hello! I\'m interested in your products.',
                buttonText: 'Chat with us',
                position: 'bottom-right',
                backgroundColor: '#25D366',
                textColor: '#ffffff',
                businessHours: {
                    enabled: false,
                    timezone: 'UTC',
                    schedule: {
                        monday: { start: '09:00', end: '17:00' },
                        tuesday: { start: '09:00', end: '17:00' },
                        wednesday: { start: '09:00', end: '17:00' },
                        thursday: { start: '09:00', end: '17:00' },
                        friday: { start: '09:00', end: '17:00' },
                        saturday: { start: '10:00', end: '14:00' },
                        sunday: { closed: true }
                    },
                    closedMessage: 'We\'re currently closed. Business hours: Mon-Fri 9AM-5PM'
                },
                popupTriggers: {
                    enabled: false,
                    delay: 5000,
                    exitIntent: false,
                    scrollPercentage: 50,
                    message: 'Need help? Chat with us on WhatsApp!'
                },
                language: 'en',
                translations: {
                    en: {
                        buttonText: 'Chat with us',
                        popupMessage: 'Need help? Chat with us on WhatsApp!',
                        closedMessage: 'We\'re currently closed. Business hours: Mon-Fri 9AM-5PM'
                    },
                    es: {
                        buttonText: 'Chatea con nosotros',
                        popupMessage: '¿Necesitas ayuda? ¡Chatea con nosotros en WhatsApp!',
                        closedMessage: 'Estamos cerrados. Horario: Lun-Vie 9AM-5PM'
                    },
                    fr: {
                        buttonText: 'Discuter avec nous',
                        popupMessage: 'Besoin d\'aide? Discutez avec nous sur WhatsApp!',
                        closedMessage: 'Nous sommes fermés. Heures: Lun-Ven 9h-17h'
                    }
                },
                ...config
            };
            
            this.isOpen = false;
            this.popupShown = false;
            this.init();
        }

        init() {
            this.createStyles();
            this.createWidget();
            this.attachEventListeners();
            this.initPopupTriggers();
        }

        createStyles() {
            const style = document.createElement('style');
            style.textContent = `
                .whatsapp-widget-container {
                    position: fixed;
                    z-index: 9999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                
                .whatsapp-widget-container.bottom-right {
                    bottom: 20px;
                    right: 20px;
                }
                
                .whatsapp-widget-container.bottom-left {
                    bottom: 20px;
                    left: 20px;
                }
                
                .whatsapp-widget-container.top-right {
                    top: 20px;
                    right: 20px;
                }
                
                .whatsapp-widget-container.top-left {
                    top: 20px;
                    left: 20px;
                }
                
                .whatsapp-button {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    background-color: ${this.config.backgroundColor};
                    color: ${this.config.textColor};
                    border: none;
                    cursor: pointer;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.3s ease;
                    position: relative;
                }
                
                .whatsapp-button:hover {
                    transform: scale(1.1);
                    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
                }
                
                .whatsapp-button svg {
                    width: 32px;
                    height: 32px;
                    fill: currentColor;
                }
                
                .whatsapp-popup {
                    position: absolute;
                    background: white;
                    border-radius: 12px;
                    padding: 16px;
                    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
                    opacity: 0;
                    pointer-events: none;
                    transition: all 0.3s ease;
                    width: 280px;
                }
                
                .whatsapp-popup.active {
                    opacity: 1;
                    pointer-events: all;
                }
                
                .bottom-right .whatsapp-popup {
                    bottom: 70px;
                    right: 0;
                }
                
                .bottom-left .whatsapp-popup {
                    bottom: 70px;
                    left: 0;
                }
                
                .top-right .whatsapp-popup {
                    top: 70px;
                    right: 0;
                }
                
                .top-left .whatsapp-popup {
                    top: 70px;
                    left: 0;
                }
                
                .whatsapp-popup-header {
                    display: flex;
                    align-items: center;
                    margin-bottom: 12px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid #e0e0e0;
                }
                
                .whatsapp-popup-avatar {
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    background-color: ${this.config.backgroundColor};
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-right: 12px;
                }
                
                .whatsapp-popup-avatar svg {
                    width: 24px;
                    height: 24px;
                    fill: white;
                }
                
                .whatsapp-popup-title {
                    font-weight: 600;
                    color: #333;
                }
                
                .whatsapp-popup-message {
                    color: #666;
                    font-size: 14px;
                    line-height: 1.5;
                    margin-bottom: 16px;
                }
                
                .whatsapp-popup-button {
                    display: inline-flex;
                    align-items: center;
                    background-color: ${this.config.backgroundColor};
                    color: white;
                    padding: 10px 20px;
                    border-radius: 24px;
                    text-decoration: none;
                    font-weight: 500;
                    transition: all 0.3s ease;
                }
                
                .whatsapp-popup-button:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(37, 211, 102, 0.3);
                }
                
                .whatsapp-popup-button svg {
                    width: 20px;
                    height: 20px;
                    margin-right: 8px;
                    fill: currentColor;
                }
                
                .whatsapp-popup-close {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    background: none;
                    border: none;
                    color: #999;
                    cursor: pointer;
                    padding: 4px;
                    border-radius: 4px;
                    transition: all 0.2s ease;
                }
                
                .whatsapp-popup-close:hover {
                    background-color: #f0f0f0;
                    color: #666;
                }
                
                .whatsapp-widget-badge {
                    position: absolute;
                    top: -5px;
                    right: -5px;
                    background-color: #ff4444;
                    color: white;
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    font-weight: bold;
                    animation: pulse 2s infinite;
                }
                
                @keyframes pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.1); }
                    100% { transform: scale(1); }
                }
                
                ${this.config.customCSS || ''}
            `;
            document.head.appendChild(style);
        }

        createWidget() {
            const container = document.createElement('div');
            container.className = `whatsapp-widget-container ${this.config.position}`;
            
            const button = document.createElement('button');
            button.className = 'whatsapp-button';
            button.innerHTML = this.getWhatsAppIcon();
            
            if (this.config.showBadge) {
                const badge = document.createElement('span');
                badge.className = 'whatsapp-widget-badge';
                badge.textContent = '1';
                button.appendChild(badge);
            }
            
            const popup = document.createElement('div');
            popup.className = 'whatsapp-popup';
            popup.innerHTML = `
                <button class="whatsapp-popup-close">&times;</button>
                <div class="whatsapp-popup-header">
                    <div class="whatsapp-popup-avatar">
                        ${this.getWhatsAppIcon()}
                    </div>
                    <div class="whatsapp-popup-title">${this.getTranslation('buttonText')}</div>
                </div>
                <div class="whatsapp-popup-message">${this.getTranslation('popupMessage')}</div>
                <a href="${this.getWhatsAppLink()}" target="_blank" class="whatsapp-popup-button">
                    ${this.getWhatsAppIcon()}
                    <span>${this.getTranslation('buttonText')}</span>
                </a>
            `;
            
            container.appendChild(button);
            container.appendChild(popup);
            document.body.appendChild(container);
            
            this.elements = {
                container,
                button,
                popup
            };
        }

        attachEventListeners() {
            this.elements.button.addEventListener('click', () => {
                if (this.isBusinessOpen()) {
                    window.open(this.getWhatsAppLink(), '_blank');
                } else {
                    this.togglePopup();
                }
            });
            
            const closeBtn = this.elements.popup.querySelector('.whatsapp-popup-close');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closePopup();
            });
            
            document.addEventListener('click', (e) => {
                if (!this.elements.container.contains(e.target)) {
                    this.closePopup();
                }
            });
        }

        initPopupTriggers() {
            if (!this.config.popupTriggers.enabled) return;
            
            if (this.config.popupTriggers.delay > 0) {
                setTimeout(() => {
                    if (!this.popupShown) {
                        this.showPopup();
                    }
                }, this.config.popupTriggers.delay);
            }
            
            if (this.config.popupTriggers.exitIntent) {
                document.addEventListener('mouseleave', (e) => {
                    if (e.clientY <= 0 && !this.popupShown) {
                        this.showPopup();
                    }
                });
            }
            
            if (this.config.popupTriggers.scrollPercentage > 0) {
                window.addEventListener('scroll', () => {
                    const scrollPercentage = (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100;
                    if (scrollPercentage >= this.config.popupTriggers.scrollPercentage && !this.popupShown) {
                        this.showPopup();
                    }
                });
            }
        }

        isBusinessOpen() {
            if (!this.config.businessHours.enabled) return true;
            
            const now = new Date();
            const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const currentDay = days[now.getDay()];
            const schedule = this.config.businessHours.schedule[currentDay];
            
            if (schedule.closed) return false;
            
            const currentTime = now.getHours() * 60 + now.getMinutes();
            const [startHour, startMin] = schedule.start.split(':').map(Number);
            const [endHour, endMin] = schedule.end.split(':').map(Number);
            const startTime = startHour * 60 + startMin;
            const endTime = endHour * 60 + endMin;
            
            return currentTime >= startTime && currentTime <= endTime;
        }

        getWhatsAppLink() {
            const message = encodeURIComponent(this.config.defaultMessage);
            const phone = this.config.phoneNumber.replace(/[^\d]/g, '');
            return `https://wa.me/${phone}?text=${message}`;
        }

        getTranslation(key) {
            if (!this.config.translations || typeof this.config.translations !== 'object') {
                return this.config[key];
            }
            const translations = this.config.translations[this.config.language] || this.config.translations.en || {};
            return translations[key] || this.config[key];
        }

        togglePopup() {
            this.isOpen = !this.isOpen;
            this.elements.popup.classList.toggle('active', this.isOpen);
        }

        showPopup() {
            this.isOpen = true;
            this.popupShown = true;
            this.elements.popup.classList.add('active');
        }

        closePopup() {
            this.isOpen = false;
            this.elements.popup.classList.remove('active');
        }

        getWhatsAppIcon() {
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
            </svg>`;
        }

        updateConfig(newConfig) {
            this.config = { ...this.config, ...newConfig };
            this.destroy();
            this.init();
        }

        destroy() {
            if (this.elements && this.elements.container) {
                this.elements.container.remove();
            }
        }
    }

    window.WhatsAppWidget = WhatsAppWidget;

    // Auto-initialize widget when loaded via Shopify Script Tag
    if (window.Shopify && window.Shopify.shop) {
        console.log('WhatsApp Widget: Auto-initializing for Shopify store');
        
        // Get the shop domain from Shopify global
        const shopDomain = window.Shopify.shop;
        const currentScript = document.currentScript || document.querySelector('script[src*="whatsapp-widget.js"]');
        
        if (currentScript) {
            const scriptSrc = currentScript.src;
            // Extract base URL more carefully to handle query parameters
            const url = new URL(scriptSrc);
            const baseUrl = `${url.protocol}//${url.host}`;
            
            console.log('WhatsApp Widget: Loading settings for shop:', shopDomain);
            console.log('WhatsApp Widget: Base URL:', baseUrl);
            
            // Fetch widget settings and initialize
            fetch(`${baseUrl}/api/whatsapp/public-settings?shop=${encodeURIComponent(shopDomain)}`, {
                headers: {
                    'ngrok-skip-browser-warning': 'true'
                }
            })
                .then(response => {
                    console.log('WhatsApp Widget: Settings response status:', response.status);
                    console.log('WhatsApp Widget: Response headers:', [...response.headers.entries()]);
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return response.json();
                })
                .then(settings => {
                    console.log('WhatsApp Widget: Loaded settings:', settings);
                    
                    if (settings && settings.phone_number) {
                        console.log('WhatsApp Widget: Initializing widget with phone:', settings.phone_number);
                        
                        new WhatsAppWidget({
                            phoneNumber: settings.phone_number,
                            defaultMessage: settings.default_message || 'Hello! I\'m interested in your products.',
                            buttonText: settings.button_text || 'Chat with us',
                            language: settings.language || 'en',
                            position: settings.position || 'bottom-right',
                            backgroundColor: settings.background_color || '#25D366',
                            textColor: settings.text_color || '#ffffff',
                            customCSS: settings.custom_css || '',
                            businessHours: {
                                enabled: !!settings.business_hours_enabled,
                                schedule: settings.business_hours_schedule || {},
                                timezone: settings.business_hours_timezone || 'UTC',
                                closedMessage: settings.closed_message || 'We\'re currently closed.'
                            },
                            popupTriggers: {
                                enabled: !!settings.popup_triggers_enabled,
                                delay: settings.popup_delay || 5000,
                                exitIntent: !!settings.popup_exit_intent,
                                scrollPercentage: settings.popup_scroll_percentage || 50,
                                message: settings.popup_message || 'Need help? Chat with us on WhatsApp!'
                            },
                            translations: settings.translations || {
                                en: {
                                    buttonText: settings.button_text || 'Chat with us',
                                    popupMessage: settings.popup_message || 'Need help? Chat with us on WhatsApp!',
                                    closedMessage: settings.closed_message || 'We\'re currently closed.'
                                }
                            }
                        });
                        
                        console.log('WhatsApp Widget: Successfully initialized!');
                    } else {
                        console.warn('WhatsApp Widget: No phone number configured or widget not found');
                    }
                })
                .catch(async (error) => {
                    console.error('WhatsApp Widget: Failed to load settings:', error);
                    
                    // Try to get the actual response text to debug
                    try {
                        const response = await fetch(`${baseUrl}/api/whatsapp/public-settings?shop=${encodeURIComponent(shopDomain)}`, {
                            headers: {
                                'ngrok-skip-browser-warning': 'true'
                            }
                        });
                        const text = await response.text();
                        console.error('WhatsApp Widget: Response text:', text.substring(0, 200));
                    } catch (debugError) {
                        console.error('WhatsApp Widget: Debug fetch failed:', debugError);
                    }
                });
        } else {
            console.warn('WhatsApp Widget: Could not find script element');
        }
    } else {
        console.log('WhatsApp Widget: Not in Shopify environment, manual initialization required');
    }
})();