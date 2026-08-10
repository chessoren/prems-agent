/**
 * The geography behind the demo inventory.
 *
 * Real cities, real districts, real streets, and rent per m² close to the
 * actual 2026 market. This matters more than it looks: the "aha moment" only
 * lands if the listings the visitor is shown are plausible for the city and
 * budget they just typed. A generic placeholder set reads as fake instantly.
 *
 * `eurPerM2` is the unfurnished monthly asking rent per m², charges excluded.
 */
export const CITIES = [
  {
    name: 'Paris',
    slug: 'paris',
    eurPerM2: 32,
    districts: [
      ['Oberkampf (11e)', ['rue Saint-Maur', 'rue Jean-Pierre Timbaud', 'rue de la Folie-Méricourt']],
      ['Montmartre (18e)', ['rue Lepic', 'rue des Abbesses', 'rue Caulaincourt']],
      ['Canal Saint-Martin (10e)', ['rue de Lancry', 'quai de Valmy', 'rue Beaurepaire']],
      ['Belleville (20e)', ['rue des Pyrénées', 'rue de Ménilmontant', 'rue Julien Lacroix']],
      ['Commerce (15e)', ['rue du Commerce', 'rue Lecourbe', 'rue de la Convention']],
      ['Mouffetard (5e)', ['rue Monge', 'rue Mouffetard', 'rue Claude Bernard']],
      ['Batignolles (17e)', ['rue des Dames', 'rue Legendre', 'avenue de Clichy']],
      ['Butte-aux-Cailles (13e)', ['rue Bobillot', 'rue de la Butte-aux-Cailles', 'rue Barrault']],
      ['Bercy (12e)', ['rue de Charenton', 'rue de Reuilly', 'avenue Daumesnil']],
      ['Pernety (14e)', ['rue Raymond Losserand', 'rue de l’Ouest', 'rue Didot']],
      ['Buttes-Chaumont (19e)', ['rue de Meaux', 'rue Manin', 'avenue Simon Bolivar']],
      ['Le Marais (3e)', ['rue de Bretagne', 'rue Charlot', 'rue de Turenne']],
    ],
  },
  {
    name: 'Nice',
    slug: 'nice',
    eurPerM2: 21,
    districts: [
      ['Vieux-Nice', ['rue Droite', 'rue Benoît Bunico', 'cours Saleya']],
      ['Carré d’Or', ['rue de France', 'rue Masséna', 'rue du Congrès']],
      ['Libération', ['avenue Malausséna', 'rue Trachel', 'avenue Borriglione']],
      ['Cimiez', ['boulevard de Cimiez', 'avenue Bellanda', 'rue Brancolar']],
      ['Riquier', ['rue Barla', 'rue Arson', 'boulevard Riquier']],
      ['Fabron', ['avenue de Fabron', 'corniche Fleurie', 'avenue des Grenadiers']],
    ],
  },
  {
    name: 'Lyon',
    slug: 'lyon',
    eurPerM2: 17.5,
    districts: [
      ['Croix-Rousse (1er)', ['rue des Pierres Plantées', 'montée de la Grande Côte', 'rue Burdeau']],
      ['Presqu’île (2e)', ['rue Victor Hugo', 'rue Auguste Comte', 'quai Saint-Antoine']],
      ['Part-Dieu (3e)', ['rue Garibaldi', 'rue Paul Bert', 'cours Lafayette']],
      ['Croix-Rousse plateau (4e)', ['boulevard de la Croix-Rousse', 'rue Denfert-Rochereau', 'rue Hénon']],
      ['Vieux Lyon (5e)', ['rue Saint-Jean', 'montée du Gourguillon', 'rue du Bœuf']],
      ['Foch (6e)', ['cours Vitton', 'rue Bugeaud', 'avenue Maréchal Foch']],
      ['Guillotière (7e)', ['rue de Marseille', 'grande rue de la Guillotière', 'rue Sébastien Gryphe']],
      ['Monplaisir (8e)', ['avenue des Frères Lumière', 'rue Villon', 'avenue Jean Mermoz']],
    ],
  },
  {
    name: 'Bordeaux',
    slug: 'bordeaux',
    eurPerM2: 16.5,
    districts: [
      ['Chartrons', ['rue Notre-Dame', 'cours Portal', 'rue Rode']],
      ['Saint-Michel', ['rue des Faures', 'rue Camille Sauvageau', 'place Meynard']],
      ['Saint-Pierre', ['rue Sainte-Catherine', 'rue du Pas-Saint-Georges', 'rue des Bahutiers']],
      ['Nansouty', ['rue de Nansouty', 'rue Malbec', 'cours de la Somme']],
      ['La Bastide', ['quai de Queyries', 'rue de Nuits', 'avenue Thiers']],
      ['Victoire', ['cours de la Marne', 'rue Élie Gintrac', 'rue Kléber']],
      ['Caudéran', ['avenue Louis Barthou', 'rue Ferdinand de Lesseps', 'avenue du Général Leclerc']],
    ],
  },
  {
    name: 'Lille',
    slug: 'lille',
    eurPerM2: 16,
    districts: [
      ['Vieux-Lille', ['rue de la Monnaie', 'rue Basse', 'rue Royale']],
      ['Wazemmes', ['rue Gambetta', 'rue des Sarrazins', 'rue Jules Guesde']],
      ['Vauban-Esquermes', ['boulevard Vauban', 'rue Colbert', 'rue de Fontenoy']],
      ['Moulins', ['rue d’Arras', 'rue de Douai', 'boulevard de Belfort']],
      ['Saint-Maurice Pellevoisin', ['rue du Faubourg de Roubaix', 'rue de Cambrai', 'avenue de la Marne']],
      ['République-Beaux-Arts', ['rue Nationale', 'rue Inkermann', 'boulevard de la Liberté']],
    ],
  },
  {
    name: 'Nantes',
    slug: 'nantes',
    eurPerM2: 15.5,
    districts: [
      ['Bouffay', ['rue de la Juiverie', 'rue de la Barillerie', 'place du Change']],
      ['Graslin', ['rue Crébillon', 'rue Franklin', 'rue Scribe']],
      ['Hauts-Pavés', ['rue du Calvaire', 'rue Paul Bellamy', 'boulevard des Poilus']],
      ['Île de Nantes', ['boulevard de la Prairie-au-Duc', 'quai François Mitterrand', 'rue La Noue Bras de Fer']],
      ['Chantenay', ['rue de la Convention', 'rue Jean Jaurès', 'place Jean Macé']],
      ['Doulon-Bottière', ['rue de la Basse-Chênaie', 'route de Sainte-Luce', 'rue du Bois Robillard']],
    ],
  },
  {
    name: 'Montpellier',
    slug: 'montpellier',
    eurPerM2: 15.5,
    districts: [
      ['Écusson', ['rue de l’Aiguillerie', 'rue de la Loge', 'rue Saint-Guilhem']],
      ['Beaux-Arts', ['rue du Faubourg Boutonnet', 'rue de Ferran', 'avenue Saint-Lazare']],
      ['Port Marianne', ['avenue Raymond Dugrand', 'rue Saint-Exupéry', 'avenue Nina Simone']],
      ['Antigone', ['place du Nombre d’Or', 'avenue Jean Mermoz', 'rue Léon Blum']],
      ['Figuerolles', ['rue du Faubourg Figuerolles', 'rue Marceau', 'rue Béranger']],
      ['Aiguelongue', ['avenue de la Justice de Castelnau', 'rue de Ferran', 'avenue du Père Soulas']],
    ],
  },
  {
    name: 'Marseille',
    slug: 'marseille',
    eurPerM2: 15,
    districts: [
      ['Le Panier (2e)', ['rue du Panier', 'rue Sainte-Françoise', 'montée des Accoules']],
      ['Notre-Dame-du-Mont (6e)', ['cours Julien', 'rue des Trois Rois', 'rue Bussy l’Indien']],
      ['Vieux-Port (1er)', ['rue Sainte', 'rue Francis Davso', 'quai de Rive Neuve']],
      ['Endoume (7e)', ['rue d’Endoume', 'boulevard Tellène', 'rue des Lices']],
      ['Castellane (6e)', ['avenue du Prado', 'rue Paradis', 'rue Breteuil']],
      ['Baille (5e)', ['boulevard Baille', 'rue Saint-Pierre', 'boulevard Chave']],
      ['Joliette (2e)', ['rue de la République', 'place de la Joliette', 'rue Peyssonnel']],
    ],
  },
  {
    name: 'Rennes',
    slug: 'rennes',
    eurPerM2: 15,
    districts: [
      ['Centre-Thabor', ['rue Saint-Melaine', 'boulevard de la Duchesse Anne', 'rue de Paris']],
      ['Sainte-Anne', ['rue Saint-Michel', 'place Sainte-Anne', 'rue de Saint-Malo']],
      ['Sud-Gare', ['avenue Jean Janvier', 'boulevard Villebois Mareuil', 'rue de Chateaugiron']],
      ['Bourg-l’Évêque', ['boulevard de Verdun', 'rue de Brest', 'rue Jules Ferry']],
      ['Villejean', ['avenue Winston Churchill', 'rue de Lorient', 'avenue Gaston Berger']],
    ],
  },
  {
    name: 'Strasbourg',
    slug: 'strasbourg',
    eurPerM2: 14.5,
    districts: [
      ['Krutenau', ['rue de Zurich', 'rue de la Krutenau', 'quai des Bateliers']],
      ['Petite France', ['rue du Bain-aux-Plantes', 'rue des Dentelles', 'quai de la Bruche']],
      ['Orangerie', ['avenue des Vosges', 'allée de la Robertsau', 'rue Schweighaeuser']],
      ['Neudorf', ['route du Polygone', 'rue de Lyon', 'avenue Jean Jaurès']],
      ['Esplanade', ['boulevard de la Victoire', 'rue de Palerme', 'allée Sainte-Anne']],
    ],
  },
  {
    name: 'Toulouse',
    slug: 'toulouse',
    eurPerM2: 14.5,
    districts: [
      ['Capitole', ['rue du Taur', 'rue Gambetta', 'rue Lafayette']],
      ['Carmes', ['rue des Filatiers', 'rue de la Dalbade', 'rue Pharaon']],
      ['Saint-Cyprien', ['rue de la République', 'allées Charles de Fitte', 'rue Réclusane']],
      ['Minimes', ['avenue des Minimes', 'rue Louis Plana', 'boulevard Silvio Trentin']],
      ['Jean Jaurès', ['allées Jean Jaurès', 'rue Bayard', 'boulevard de Strasbourg']],
      ['Rangueil', ['avenue de Rangueil', 'rue Saint-Jean', 'avenue Crampel']],
      ['Compans-Caffarelli', ['boulevard Lascrosses', 'rue de Sébastopol', 'allées de Barcelone']],
    ],
  },
];

export const AGENCIES = [
  'Foncia',
  'Orpi',
  'Century 21',
  'Laforêt',
  'Guy Hoquet',
  'Nexity',
  'Square Habitat',
  'Stéphane Plaza Immobilier',
  'ERA Immobilier',
  'L’Adresse',
  'Citya Immobilier',
  'Immo de France',
];

export const FEATURES = [
  'Balcon',
  'Ascenseur',
  'Cave',
  'Parking',
  'Très lumineux',
  'Refait à neuf',
  'Cuisine équipée',
  'Double vitrage',
  'Proche métro',
  'Vue dégagée',
  'Calme sur cour',
  'Interphone',
  'Local vélo',
  'Fibre optique',
  'Gardien',
  'Terrasse',
  'Parquet ancien',
  'Dernier étage',
];
