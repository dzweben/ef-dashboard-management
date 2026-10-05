// Seed category registry. Colors are OKLCH L=0.78 (readable on the dark console),
// hues spread per group. Claude adds new categories at runtime with
// categories.makeCategory(), which picks a color far from these.

export const DEFAULT_CATEGORIES = [
  // research
  { id: 'rsa', name: 'RSA', group: 'research', color: '#89b7ff', glyph: 'RS', order: 10,
    aliases: ['rsa', 'representational similarity', 'nyx', 'johanna', 'ppi'] },
  { id: 'dti', name: 'DTI', group: 'research', color: '#3ecce2', glyph: 'DT', order: 11,
    aliases: ['dti', 'diffusion', 'tractography', 'ingrid'] },
  { id: 'sdn', name: 'SDN / SPARK', group: 'research', color: '#afabff', glyph: 'SD', order: 12,
    aliases: ['sdn', 'spark', 'neuromelanin', 'ronan', '3dmvm', 'chloe', 'univariate'] },
  { id: 'tubric', name: 'TUBRIC', group: 'research', color: '#4dd0b7', glyph: 'TB', order: 13,
    aliases: ['tubric', 'kiosk', 'scanner', 'shenghan', 'avi', 'linkedin'] },
  { id: 'manuscripts', name: 'Manuscripts', group: 'research', color: '#cea0f7', glyph: 'MS', order: 14,
    aliases: ['manuscript', 'manuscripts', 'cablab', 'abcd', 'ncvs', 'deft', 'jason', 'journal', 'revision', 'reviewer'] },
  { id: 'caadc', name: 'CAADC / ADIS', group: 'research', color: '#6bc3f4', glyph: 'AD', order: 15,
    aliases: ['caadc', 'adis', 'redcap'] },
  { id: 'predis', name: 'Predissertation', group: 'research', color: '#e49ada', glyph: 'PD', order: 16,
    aliases: ['predis', 'predissertation', 'pre-dissertation', 'thesis', 'dissertation'] },
  { id: 'ef', name: 'EF', group: 'research', color: '#6fd087', glyph: 'EF', order: 17,
    aliases: ['ef', 'executive function', 'executive functioning'],
    note: 'Ask Danny what EF covers so Claude files things correctly.' },
  { id: 'dev', name: 'Dev projects', group: 'research', color: '#9dbbd6', glyph: 'DV', order: 18,
    aliases: ['server', 'lite', 'website', 'qualtrics', 'app', 'code', 'github', 'script'] },
  // clinical
  { id: 'psc', name: 'Clinical (PSC)', group: 'clinical', color: '#fd93a7', glyph: 'PS', order: 20,
    aliases: ['psc', 'client', 'clients', 'session notes', 'clinical', 'titanium', 'supervision', 'dbt', 'visit', 'intake', 'assessment report'] },
  // coursework
  { id: 'cbt', name: 'CBT', group: 'coursework', color: '#d1b64a', glyph: 'CB', order: 30,
    aliases: ['cbt', 'ocd', 'workshop', 'dyads'] },
  { id: 'multivar', name: 'Multivariate', group: 'coursework', color: '#a9c461', glyph: 'MV', order: 31,
    aliases: ['multivar', 'multivariate', 'mv'] },
  { id: 'practicum', name: 'Assessment practicum', group: 'coursework', color: '#e4ac59', glyph: 'PR', order: 32,
    aliases: ['practicum'] },
  // teaching
  { id: 'undergrad', name: 'Undergrad', group: 'teaching', color: '#8dca80', glyph: 'UG', order: 40,
    aliases: ['undergrad', 'undergrads', 'mentee', 'mentoring', 'ra tutorial', 'tutorial', 'lesson plan', 'lily', 'ras'] },
  // service
  { id: 'gradroles', name: 'Grad roles', group: 'service', color: '#e89dc0', glyph: 'GR', order: 50,
    aliases: ['student rep', 'committee', 'ai + research', 'ai and research', 'grad rep', 'sr profile'] },
  // admin
  { id: 'admin', name: 'Admin', group: 'admin', color: '#a7b9d1', glyph: 'AM', order: 60,
    aliases: ['admin', 'email', 'emails', 'whentomeet', 'citi', 'reimburse', 'payment', 'register', 'vpn', 'form'] },
  { id: 'meetings', name: 'Meetings', group: 'admin', color: '#85c2d8', glyph: 'MT', order: 61,
    aliases: ['meeting', 'meetings', '1:1', 'one on one', 'lab meeting', 'users meeting'] },
  // life
  { id: 'home', name: 'Home', group: 'life', color: '#6ccea6', glyph: 'HM', order: 70,
    aliases: ['clean', 'cleaning', 'laundry', 'vacuum', 'dishes', 'trash', 'groceries', 'grocery', 'closet', 'car', 'dry cleaning', 'donate', 'returns', 'plants'] },
  { id: 'ziggy', name: 'Ziggy', group: 'life', color: '#f2a359', glyph: 'ZG', order: 71,
    aliases: ['ziggy', 'dog', 'vet', 'walk ziggy', 'boarding'] },
  { id: 'health', name: 'Health', group: 'life', color: '#f99b7e', glyph: 'HL', order: 72,
    aliases: ['dentist', 'doctor', 'psychiatry', 'pharmacy', 'gym', 'workout', 'meds', 'sleep'] },
  { id: 'personal', name: 'Personal', group: 'life', color: '#b6b0e2', glyph: 'PE', order: 73,
    aliases: ['wedding', 'gift', 'birthday', 'family', 'brother', 'holiday', 'trip', 'flight', 'hotel'] },
];
