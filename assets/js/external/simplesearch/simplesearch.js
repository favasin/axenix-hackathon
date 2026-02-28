const input = document.getElementById("elbi-input");
const results = document.getElementById("elbi-results");
const request = new Request("/index.json");
const display_score = false; // Set to true if you want to see the score in the results
const display_counter = true;
const snippet_lenght = 200;

fetch(request)
    .then(response => response.json())
    .then(data => {
        let pages = data;
        var searchtimer;

        input.addEventListener("input",function(){

            clearTimeout(searchtimer);
            searchtimer = setTimeout(() => {

                let filteredPages = pages;

                // If there is something in the search field
                if (input.value != ""){

                    // Reset the page score to zero
                    filteredPages.forEach(function(page) {
                        page.score = 0;
                        page.toSearchResult = false;
                        page.chapter = parseInt(page.relpermalink.substring(1, 3));
                    });

                    // Create array of search terms, split by space character
                    // Normalize and replace diacritics
                    let searchterms = input.value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").match(/(".*?"|[^"\s]+)+(?=\s*|\s*$)/g);

                    // Apply a filter to the array of pages for each search term
                    searchterms.forEach(function(term) {
                        if (term != "") {
                            term = term.replaceAll('\"', '');
                            filteredPages = filteredPages.filter(function(page) {
                                // The description is the full object, includes title, tags, categories, and content text
                                // You could make this more specific by doing something like:
                                // let description = page.title;
                                // or you could combine fields, for example page title and tags:
                                // let description = page.title + ' ' + JSON.stringify(page.tags)
                                let description = JSON.stringify(page);
                                return description.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().indexOf(term.toLowerCase()) !== -1;
                            });
                        }
                    }); // end of filter for loop

                    // Apply weighting to the results
                    searchterms.forEach(function(term) {
                        if (term != "") {
                            term = term.replaceAll('\"', '');
                            // Loop through each page in the array
                            filteredPages.forEach(function(page) {

                                if (!isNaN(page.chapter)){
                                    page.chapter = page.chapter * -1;
                                    
                                    // Assign 3 points for search term in title
                                    if (page.title.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().includes(term.toLowerCase())) {
                                        page.score += 3;
                                        page.toSearchResult = true;
                                    };

                                    // Assign 2 points for search term in tags
                                    if (JSON.stringify(page.tags).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().includes(term.toLowerCase())) {
                                        page.score += 2;
                                        page.toSearchResult = true;
                                    };

                                    // Assign 1 point for search term in content
                                    if (page.content.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().includes(term.toLowerCase())) {
                                        page.score += 1;
                                        page.toSearchResult = true;
                                    };

                                    // Assign 1 point for search term in the page categories
                                    if (JSON.stringify(page.categories).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().includes(term.toLowerCase())) {
                                        page.score += 1;
                                        page.toSearchResult = true;
                                    };

                                    page.score += page.chapter;
                                }
                            })
                        };                                      
                    });

                    // Filter out any pages that don't have a score of at least 1
                    filteredPages = filteredPages.filter(function(page){
                        return page.toSearchResult;
                    })

                    // sort filtered results by title
                    // borrowed from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort
                    filteredPages.sort(function(a, b) {
                        const titleA = a.title.toLowerCase(); // ignore upper and lowercase
                        const titleB = b.title.toLowerCase(); // ignore upper and lowercase
                        if (titleA < titleB) {
                            return -1;
                        }
                        if (titleA > titleB) {
                            return 1;
                        }
                        // titles must be equal
                        return 0;
                    });
                    
                    // then sort by page score
                    filteredPages.sort((a, b) => b.score - a.score);

                    var pagecounter = 1;
                    results.innerHTML = "";

                    if (display_counter)
                        results.insertAdjacentHTML("beforeend","<p>Всего найдено: " + filteredPages.length + " результатов.</p>");

                    // For each of the pages in the final filtered list, insert into the results list
                    filteredPages.forEach(function(page) {
                        var titleOrigin = page.title.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
                        var contentOrigin = page.content.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
                        var tagsOrigin = JSON.stringify(page.tags).normalize("NFD").replace(/[\u0300-\u036f]/g,"");
                        var indexTitleStart;
                        var indexContentStart;
                        var indexTagsStart;
                        var contentResult = "";

                        searchterms.forEach(function(term) {
                            term = term.replaceAll('\"', '');

                            indexTitleStart = titleOrigin.toLowerCase().indexOf(term.toLowerCase());
                            if (indexTitleStart > -1){
                                titleOrigin = titleOrigin.replace(titleOrigin.substring(indexTitleStart, indexTitleStart + term.length), '<mark>' + titleOrigin.substring(indexTitleStart, indexTitleStart + term.length) + '</mark>');
                            }

                            indexContentStart = contentOrigin.toLowerCase().indexOf(term.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase());
                            if (indexContentStart > -1){
                                var s = contentOrigin.replace(contentOrigin.substring(indexContentStart, indexContentStart + term.length), '<mark>' + contentOrigin.substring(indexContentStart, indexContentStart + term.length) + '</mark>');
                                contentResult = contentResult + s.slice(indexContentStart > snippet_lenght ? indexContentStart - snippet_lenght : indexContentStart, indexContentStart + term.length + snippet_lenght) + '<hr>';
                            }

                            indexTagsStart = tagsOrigin.toLowerCase().indexOf(term.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase());
                            if (indexTagsStart > -1){
                                tagsOrigin = tagsOrigin.replace(tagsOrigin.substring(indexTagsStart, indexTagsStart + term.length), '<mark>' + tagsOrigin.substring(indexTagsStart, indexTagsStart + term.length) + '</mark>');
                            }
                        });

                        if (display_counter) {
                            results.insertAdjacentHTML("beforeend","<p>№ " + pagecounter + "</p>");
                            pagecounter += 1;
                        };

                        results.insertAdjacentHTML("beforeend","<li class='elbi-results-item'><h2 style='font-size: 1.5rem;'><a href='" + page.relpermalink + "'>" + titleOrigin + "</a></h2><p>" + contentResult + "</p><p style='margin-top: 5px'>Tagged: <strong>" + tagsOrigin + "</strong></p></li>");

                        if (display_score) {
                            results.insertAdjacentHTML("beforeend","<p>Result score: " + page.score + "</p>")
                        };
                        
                    }); // end of page for loop

                }; // end of IF
            }, 1000); // timeout
        }); // end of event listener
        /* Shared flow которыи можно использовать для подготовки ТЗ на реализацию API-методов */
    });