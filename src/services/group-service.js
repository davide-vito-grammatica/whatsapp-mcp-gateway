/**
 * GroupService - Gestione Gruppi WhatsApp
 *
 * Fornisce funzionalità per:
 * - Identificare ID gruppi WhatsApp
 * - Cache intelligente dei gruppi
 * - Validazione appartenenza ai gruppi
 * - Informazioni dettagliate sui gruppi
 */

// Rimosso import logger - uso console diretto

let groupsCache = {
    lastUpdate: 0,
    ttl: 5 * 60 * 1000, // 5 minuti
    data: []
};

class GroupService {
    /**
     * Verifica se un ID è un gruppo WhatsApp
     * @param {string} id - ID da verificare
     * @returns {boolean} True se è un gruppo
     */
    static isGroupId(id) {
        return typeof id === 'string' && id.endsWith('@g.us');
    }

    /**
     * Recupera tutti i gruppi WhatsApp (con cache)
     * @param {Object} sock - Socket WhatsApp
     * @param {boolean} forceRefresh - Forza aggiornamento cache
     * @returns {Array} Lista gruppi
     */
    static async getGroups(sock, forceRefresh = false) {
        const now = Date.now();

        // Usa cache se valida e non forzato refresh
        if (!forceRefresh &&
            groupsCache.data.length > 0 &&
            (now - groupsCache.lastUpdate) < groupsCache.ttl) {
            console.log('📋 Uso cache gruppi esistente', {
                count: groupsCache.data.length,
                ageMinutes: Math.round((now - groupsCache.lastUpdate) / 60000)
            });
            return groupsCache.data;
        }

        if (!sock) {
            console.warn('⚠️ Socket WhatsApp non disponibile, uso cache precedente');
            return groupsCache.data;
        }

        try {
            console.log('🔄 Aggiornamento lista gruppi...');
            const groups = await sock.groupFetchAllParticipating();

            const groupList = Object.values(groups).map(group => {
                // Trova informazioni utente corrente nel gruppo
                const currentUser = sock.user?.id || '';
                const userParticipant = group.participants?.find(p =>
                    p.id === currentUser || p.id.includes(currentUser.split('@')[0])
                );

                return {
                    id: group.id,
                    subject: group.subject || 'Gruppo senza nome',
                    description: group.desc || '',
                    participantsCount: group.participants?.length || 0,
                    isAnnounce: !!group.announce,
                    createdAt: group.creation ? new Date(group.creation * 1000) : null,
                    owner: group.owner || null,
                    isAdmin: userParticipant &&
                            (userParticipant.admin === 'admin' || userParticipant.admin === 'superadmin'),
                    canSend: !group.announce ||
                            (userParticipant && userParticipant.admin) ||
                            false,
                    // Supporto messaggi effimeri
                    ephemeralExpiration: group.ephemeralDuration || null,
                    isEphemeral: !!(group.ephemeralDuration && group.ephemeralDuration > 0),
                    ephemeralDurationText: this.formatEphemeralDuration(group.ephemeralDuration),
                    lastUpdate: now
                };
            });

            // Ordina per nome gruppo
            groupList.sort((a, b) => (a.subject || '').localeCompare(b.subject || ''));

            groupsCache = {
                lastUpdate: now,
                ttl: groupsCache.ttl,
                data: groupList
            };

            console.log(`✅ Cache gruppi aggiornata: ${groupList.length} gruppi trovati`);
            return groupList;
        } catch (error) {
            console.error('❌ Errore recupero gruppi:', error.message);

            // Ritorna cache precedente in caso di errore
            if (groupsCache.data.length > 0) {
                console.warn('⚠️ Uso cache precedente a causa di errore');
                return groupsCache.data;
            }

            throw new Error(`Impossibile recuperare gruppi: ${error.message}`);
        }
    }

    /**
     * Recupera informazioni di un gruppo specifico
     * @param {Object} sock - Socket WhatsApp
     * @param {string} groupId - ID del gruppo
     * @returns {Object} Informazioni gruppo
     */
    static async getGroupInfo(sock, groupId) {
        if (!this.isGroupId(groupId)) {
            throw new Error('ID gruppo non valido (deve terminare con @g.us)');
        }

        try {
            const groups = await this.getGroups(sock);
            const group = groups.find(g => g.id === groupId);

            if (!group) {
                // Tenta recupero diretto se non in cache
                try {
                    const metadata = await sock.groupMetadata(groupId);
                    console.log(`📋 Gruppo trovato tramite metadata: ${metadata.subject}`);
                    return {
                        id: metadata.id,
                        subject: metadata.subject,
                        description: metadata.desc || '',
                        participantsCount: metadata.participants?.length || 0,
                        isAnnounce: !!metadata.announce,
                        createdAt: metadata.creation ? new Date(metadata.creation * 1000) : null,
                        owner: metadata.owner || null,
                        isAdmin: false, // Non possiamo determinarlo senza partecipanti dettagliati
                        canSend: !metadata.announce, // Assumiamo che si possa inviare se non announce
                        fromMetadata: true
                    };
                } catch (metaError) {
                    throw new Error('Gruppo non trovato o non sei membro');
                }
            }

            return group;
        } catch (error) {
            console.error(`❌ Errore info gruppo ${groupId}:`, error.message);
            throw error;
        }
    }

    /**
     * Valida se si può inviare messaggi a un gruppo
     * @param {Object} sock - Socket WhatsApp
     * @param {string} groupId - ID del gruppo
     * @returns {boolean} True se si può inviare
     */
    static async canSendToGroup(sock, groupId) {
        try {
            const groupInfo = await this.getGroupInfo(sock, groupId);

            // Se è un gruppo announce, verifica permessi admin
            if (groupInfo.isAnnounce && !groupInfo.isAdmin) {
                console.warn(`⚠️ Gruppo ${groupId} è announce-only e non sei admin`);
                return false;
            }

            return true;
        } catch (error) {
            console.error(`❌ Impossibile verificare permessi gruppo ${groupId}:`, error.message);
            return false;
        }
    }

    /**
     * Ottiene gruppi dalla cache (senza aggiornamento)
     * @returns {Array} Gruppi in cache
     */
    static getCachedGroups() {
        return groupsCache.data;
    }

    /**
     * Pulisce la cache dei gruppi
     */
    static clearCache() {
        console.log('🗑️ Pulizia cache gruppi');
        groupsCache = {
            lastUpdate: 0,
            ttl: groupsCache.ttl,
            data: []
        };
    }

    /**
     * Ottiene statistiche della cache
     * @returns {Object} Statistiche cache
     */
    static getCacheStats() {
        const now = Date.now();
        const ageMinutes = Math.round((now - groupsCache.lastUpdate) / 60000);
        const isExpired = (now - groupsCache.lastUpdate) > groupsCache.ttl;

        return {
            count: groupsCache.data.length,
            lastUpdate: new Date(groupsCache.lastUpdate).toISOString(),
            ageMinutes,
            ttlMinutes: Math.round(groupsCache.ttl / 60000),
            isExpired,
            isValid: groupsCache.data.length > 0 && !isExpired
        };
    }

    /**
     * Cerca gruppi per nome o descrizione
     * @param {string} searchTerm - Termine di ricerca
     * @returns {Array} Lista gruppi filtrata
     */
    static searchGroups(searchTerm) {
        if (!searchTerm || typeof searchTerm !== 'string') {
            return groupsCache.data;
        }

        const term = searchTerm.toLowerCase();
        return groupsCache.data.filter(group =>
            (group.subject || '').toLowerCase().includes(term) ||
            (group.description || '').toLowerCase().includes(term)
        );
    }

    /**
     * Formatta durata messaggi effimeri in testo leggibile
     * @param {number|null} duration - Durata in secondi
     * @returns {string} Testo formattato
     */
    static formatEphemeralDuration(duration) {
        if (!duration) return 'Disabilitato';

        const durations = {
            86400: '24 ore',
            604800: '7 giorni',
            7776000: '90 giorni'
        };

        return durations[duration] || `${duration} secondi`;
    }

    /**
     * Gestisce messaggi effimeri per gruppo
     * @param {Object} sock - Socket Baileys
     * @param {string} groupId - ID del gruppo
     * @param {number} duration - Durata in secondi (0 per disabilitare)
     * @returns {Object} Risultato operazione
     */
    static async setGroupEphemeral(sock, groupId, duration = 0) {
        if (!this.isGroupId(groupId)) {
            throw new Error('ID gruppo non valido');
        }

        try {
            await sock.groupToggleEphemeral(groupId, duration);

            // Aggiorna cache
            this.clearCache();
            await this.getGroups(sock, true);

            console.log(`✅ Messaggi effimeri ${duration > 0 ? 'abilitati' : 'disabilitati'} per gruppo ${groupId}`);

            return {
                groupId,
                ephemeralEnabled: duration > 0,
                duration: duration,
                durationText: this.formatEphemeralDuration(duration)
            };
        } catch (error) {
            console.error(`❌ Errore impostazione effimeri gruppo ${groupId}:`, error.message);
            throw error;
        }
    }
}

module.exports = GroupService;
