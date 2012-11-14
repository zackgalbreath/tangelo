// This is declared null for now - it will be initialized in the window's
// onready method, as it depends on elements being loaded in the page.
var graph = null;

// Top-level container object for this js file.
var NER = {};

// "nodes" is a table of entity names, mapping to an array position generated
// uniquely by the "counter" variable.  Once the table is complete, the nodes
// table can be recast into an array.
NER.nodes = {};
NER.links = {};
NER.counter = 0;
NER.linkcounter = 0;

// A catalog of NER types found by the analysis.  This will be used to construct
// the color legend at the top of the graph display.
NER.types = {};

// This count will signal when the last ajax request has completed, and graph
// assembly can continue.
NER.num_files = 0;
NER.files_processed = 0;

// This table stores formatted filename information that can be dynamically
// added to in different situations ("processing" to "processed", etc.).
NER.filenames = {};

function processFile(filename, id){
    return function(e){
        // Grab the text of the file.
        var text = e.target.result;

        // Create a "progress" bullet point describing the current
        // AJAX state of this file.

        //var elem = document.createElement("li");
        //elem.innerHTML = "processing " + filename;
        //elem.setAttribute("id", filename.replace(".","-"));
        //elem.setAttribute("class", "processing inprogress");
        //$("#blobs").get(0).appendChild(elem);

        // Mark the appropriate list item as being processed.
        var li = d3.select("#" + id);
        li.html(NER.filenames[filename] + " processing")
            .classed("processing inprogress", true);

        var file_hash = CryptoJS.MD5(text).toString();

        // Check to see if the file contents were already processed,
        // by querying the database for the results.  If they are
        // found, retrieve them directly; if not, fire the AJAX call
        // below to compute the results (but db cache the result
        // when it finishes!).
        $.ajax({
            type: 'POST',
            url: '/service/mongo/xdata/ner-cache',
            data: {
                file_hash: file_hash
            },
            success: function(data){
                // Check the response - if it is blank, launch the
                // second AJAX call to directly compute the NER set,
                // and store it in the database.
                if(data == '[]'){
                    $.ajax({
                        type: 'POST',
                        url: '/service/NER',
                        data: {
                            text: text
                        },
                        dataType: 'text',
                        success: processFileContents(filename, id, file_hash),
                        error: function(){
                            $("#" + filename.replace(".","-")).removeClass("inprogress").addClass("failed").get(0).innerHTML = filename + " processed";
                        }
                    });
                }
                else{
                    // The data returned from the DB is in MongoDB format.  Read
                    // it into a JSON object, then extract the payload.
                    var jsdata = $.parseJSON(data);

                    // TODO(choudhury): error checking.  Make sure
                    // that "jsdata" has only a single element, etc.

                    // The call to processFileContents() generates a
                    // function (in which the file_hash parameter is
                    // OMITTED); the second invocation calls that
                    // function to actually process the data.
                    processFileContents(filename, id)(jsdata[0].data);
                }
            }
        });
    };
}

// This function can be called with a filename to *generate* an AJAX-success
// callback function to process the contents of some file.  The parameter passed
// into the generator is so that the callback has access to the name of the file
// being processed.
function processFileContents(filename, id, file_hash){
    return function(data){
        var li = d3.select("#" + id)
            .classed("inprogress", false)
            .classed("processing done", true);
        li.html(NER.filenames[filename] + ' processed');

        // If the "store" parameter is set to true, store the data in the
        // database (caching it for future retrieval).
        if(file_hash !== undefined){
            // Fire an AJAX call that will install the computed data in the DB.
            $.ajax({
                type: 'POST',
                url: '/service/mongo/xdata/ner-cache',
                data: {
                    file_hash: file_hash,
                data: data
                }
            });
        }

        // Create an entry for the document itself.
        NER.nodes[filename] = {
            name: filename,
            type: "DOCUMENT",
            count: 1,
            id: NER.counter++
        };
        var doc_index = NER.counter - 1;

        // Augment the count for the DOCUMENT type in the type table.
        NER.types["DOCUMENT"] = NER.types["DOCUMENT"] + 1 || 1;

        // Extract the JSON object from the AJAX response.
        var entities = $.parseJSON(data);

        // Process the entities.
        $.each(entities, function(i, e){
            // Place the entity into the global entity list
            // if not already there.
            //
            // Also update the count of this entity.
            var key = '["' + e[0] + '","' + e[1] + '"]';
            if(!NER.nodes.hasOwnProperty(key)){
                // Place the entity into the node table.
                NER.nodes[key] = {
                    name: e[1],
            type: e[0],
            count: 1,
            id: NER.counter++
                };

            // Augment the type count.
            NER.types[e[0]] = NER.types[e[0]] + 1 || 1;
            }
            else{
                NER.nodes[key].count++;
            }
        var entity_index = NER.nodes[key].id;

        // Enter a link into the link list, or just increase the count if
        // the link exists already.
        var link = "(" + entity_index + "," + doc_index + ")";
        if(!NER.links.hasOwnProperty(link)){
            NER.links[link] = {
                source: entity_index,
                target: doc_index,
                count: 1,
                id: NER.linkcounter++
            };
        }
        else{
            NER.links[link].count++;
        }
        });

        // Increment the number of successfully processed files; if the number
        // reaches the number of total files to process, launch the final step
        // of assembling the graph.
        ++NER.files_processed;

        if(NER.files_processed == NER.num_files){
            graph.assemble(NER.nodes, NER.links, NER.types, NER.nodeSlider.getValue());
            graph.recomputeGraph(NER.nodeSlider.getValue());
            graph.render();
        }
    };
}

function handleFileSelect(evt){
    // Grab the list of files selected by the user.
    var files = evt.target.files;

    // Compute how many of these files will actually be processed for named
    // entities (see comment below for explanation of how the files are vetted).
    NER.num_files = 0;
    $.each(files, function(k, v){
        if(v.type == '(n/a)' || v.type.slice(0,5) == 'text/'){
            NER.num_files++;
        }
    });

    // Now run through the files, using a callback to load the content from the
    // proper ones and pass it to an ajax call to perform named-entity
    // recognition.
    var output = [];
    for(var i=0; i<files.length; i++){
        var f = files[i];

        // Create globally usable names to use to refer to the current file.
        var filename = escape(f.name);
        var id = filename.replace(".", "-");

        // Decide whether to process a selected file or not - accept everything
        // with a mime-type of text/*, as well as those with unspecified type
        // (assume the user knows what they are doing in such a case).
        var using = null;
        var status = null;
        var msg = null;
        if(f.type == '(n/a)'){
            status = "accepted";
            msg = "ok, assuming text";
            using = true;
        }
        else if(f.type.slice(0,5) == 'text/'){
            status = "accepted";
            msg = "ok";
            using = true;
        }
        else{
            status = "rejected";
            msg = "rejected";
            using = false;
        }

        // Create a list item element to represent the file.  Tag it with an id
        // so it can be updated later.
        var li = d3.select("#file-info").append("li");
        NER.filenames[filename] = '<span class=filename>' + filename + '</span>';
        li.attr("id", id)
            .classed("rejected", !using)
            .html(NER.filenames[filename] + '<span class=filename>(' + (f.type || 'n/a') + ')</span> - ' + f.size + ' bytes ' + (using ? '<span class=ok>(ok)</span>' : '<span class=rejected>(rejected)</span>') );

        if(using){
            var reader = new FileReader();
            reader.onload = processFile(filename, id);
            reader.readAsText(f);
        }
    }

    // Remove the "rejected" list items by fading them away.
    d3.selectAll("li.rejected")
        .transition()
        .delay(1000)
        .duration(2000)
        .style("opacity", 0.0)
        .style("height", "0px")
        .remove();
}

window.onload = function(){
    graph = (function(){
        // Original data as passed to this module by a call to assemble().
        var orignodes = {};
        var origlinks = {};

        // Data making up the graph.
        var nodes = [];
        var links = [];

        // A counter to help uniquely identify incoming data from different sources.
        var counter = 0;

        // Configuration parameters for graph rendering.
        var config = {
            // Whether to make the radius of each node proportional to the number of
            // times it occurs in the corpus.
            nodeScale: false,

          // Whether to thicken a link proportionally to the number of times it
          // occurs in the corpus.
          linkScale: false 
        };

        var color = d3.scale.category20();
        var legend = d3.select("#color-legend");

        var svg = d3.select("#graph");

        var width = svg.attr("width"),
            height = svg.attr("height");

        var force = d3.layout.force()
            .charge(-120)
            .linkDistance(30)
            .size([width, height]);

        return {
            assemble: function(nodedata, linkdata, typedata, nodecount_threshold){
                // Store copies of the incoming data.
                orignodes = {};
                $.each(nodedata, function(k,v){
                    orignodes[k] = v;
                });

                origlinks = {};
                $.each(linkdata, function(k,v){
                    origlinks[k] = v;
                });

                // Compute the graph connectivity.
                //this.recomputeGraph(nodecount_threshold);

                // Loop through the types and place a color swatch in the legend
                // area for each one.
                $.each(typedata, function(t){
                    var elemtext = d3.select(document.createElement("div"))
                    .style("border", "solid black 1px")
                    .style("background", color(t))
                    .style("display","inline-block")
                    .style("width", "20px")
                    .html("&nbsp;")
                    .node().outerHTML;

                    var li = legend.append("li")
                    .html(elemtext + "&nbsp;" + t);
                });
            },

            recomputeGraph: function(nodecount_threshold){
                // Copy the thresholded nodes over to the local array, and
                // record their index as we go.  Also make a local copy of the
                // original, unfiltered data.

                //nodes = [];
                nodes.length = 0;
                var fixup = {};
                $.each(orignodes, function(k,v){
                    if(v.count >= nodecount_threshold || v.type === "DOCUMENT"){
                        fixup[v.id] = nodes.length;
                        nodes.push(v);
                    }
                });

                // Copy the link data to the local links array, first checking
                // to see that both ends of the link are actually present in the
                // fixup index translation array (i.e., that the node data is
                // actually present for this threshold value).  Also make a
                // local copy of the origlinks, unfiltered link data.

                //links = [];
                links.length = 0;
                $.each(origlinks, function(k,vv){
                    var v = {};
                    for(p in vv){
                        if(vv.hasOwnProperty(p)){
                            v[p] = vv[p];
                        }
                    }

                    if(fixup.hasOwnProperty(v.source) && fixup.hasOwnProperty(v.target)){
                        // Use the fixup array to edit the index location of the
                        // source and target.
                        v.source = fixup[v.source];
                        v.target = fixup[v.target];
                        links.push(v);
                    }
                });

                this.updateConfig();

                var link = svg.selectAll("line.link")
                    .data(links, function(d) { return d.id; });

                link.enter().append("line")
                    .classed("link", true)
                    .attr("x1", 400)
                    .attr("y1", 400)
                    .attr("x2", 600)
                    .attr("y2", 600)
                    .style("stroke-width", this.linkScalingFunction());

                link.exit().remove();

                var node = svg.selectAll("circle.node")
                    .data(nodes, function(d) { return d.id; });

                node.enter().append("circle")
                    .classed("node", true)
                    .attr("r", this.nodeScalingFunction())
                    .attr("cx", width/2)
                    .attr("cy", height/2)
                    .style("fill", function(d) { return color(d.type); })
                    .style("opacity", 0.0)
                    .call(force.drag)
                    .transition()
                    .duration(1000)
                    .style("opacity", 1.0);

                node.exit()
                    .transition()
                    .duration(1000)
                    .style("opacity", 0.0)
                    .remove();

                //force.stop().nodes(nodes).links(links).start();

                //this.render();

                force.stop()
                    .nodes(nodes)
                    .links(links)
                    .start();

                force.on("tick", function(){
                    link
                        .attr("x1", function(d) { return d.source.x; })
                        .attr("y1", function(d) { return d.source.y; })
                        .attr("x2", function(d) { return d.target.x; })
                        .attr("y2", function(d) { return d.target.y; });

                    node
                        .attr("cx", function(d) { return d.x; })
                        .attr("cy", function(d) { return d.y; });
                    });

            },

                render: function(){
/*                    // Make sure the config is up-to-date.*/
                    //this.updateConfig();

                    force.stop()
                        .nodes(nodes)
                        .links(links)
                        .start();

                    //var link = svg.selectAll("line.link")
                        //.data(links, function(d) { return d.id; })
                        //.enter().append("line")
                        //.classed("link", true)
                        //.style("stroke-width", this.linkScalingFunction());

                    //var node = svg.selectAll("circle.node")
                        //.data(nodes, function(d) { return d.id; });
                    
                    //node.enter().append("circle")
                        //.classed("node", true)
                        //.attr("r", this.nodeScalingFunction())
                        //.style("fill", function(d) { return color(d.type); })
                        //.call(force.drag);

//[>                    node.exit()<]
                        ////.transition()
                        ////.duration(1000)
                        ////.style("opacity", 0.0)
                        ////.remove();

                    var node = svg.selectAll("circle.node");
                    var link = svg.selectAll("line.link");
                    force.on("tick", function(){
                        link.attr("x1", function(d) { return d.source.x; })
                        .attr("y1", function(d) { return d.source.y; })
                        .attr("x2", function(d) { return d.target.x; })
                        .attr("y2", function(d) { return d.target.y; });

                    node.attr("cx", function(d) { return d.x; })
                        .attr("cy", function(d) { return d.y; });
                    });
                },

                updateConfig: function(){
                    // Sweep through the configuration elements and set the boolean
                    // flags appropriately.
                    var check = $("#nodefreq")[0];
                    config.nodeScale = check.checked;

                    check = $("#linkfreq")[0];
                    config.linkScale = check.checked;        
                },

                applyConfig: function(){
                    // Reset the attributes on the nodes and links according to
                    // the current config settings.
                    svg.selectAll("line.link")
                        .transition()
                        .duration(2000)
                        .style("stroke-width", this.linkScalingFunction());

                    svg.selectAll("circle.node")
                        .transition()
                        .duration(1000)
                        .attr("r", this.nodeScalingFunction());
                },

                nodeScalingFunction: function(){
                    if(config.nodeScale){
                        return function(d) { return 5*Math.sqrt(d.count); };
                    }
                    else{
                        return 5;
                    }
                },

                linkScalingFunction: function(){
                    if(config.linkScale){
                        return function(d) { return Math.sqrt(d.count); };
                    }
                    else{
                        return 1;
                    }
                }
        };
    })();

    // Initialize the slider for use in filtering.
    var sliderInit = function(sliderId, displayId, callback){
        var slider = $("#" + sliderId);
        var display = d3.select("#" + displayId);

        var config = {
            change: function(e, ui){
                if(callback){
                    callback(ui.value);
                }
            },

            slide: function(e, ui){
                display.html(ui.value);
            }
        };

        return {
            setConfig: function() { slider.slider(config); },
            setMax: function(max) { config.max = max; },
            getValue: function() { return slider.slider("value"); }
        };
    };

    //NER.nodeSlider = sliderInit("slider", "value", function(v) { graph.recomputeGraph(v); graph.render(); });
    //NER.nodeSlider = sliderInit("slider", "value", function(v) { graph.render(); });
    NER.nodeSlider = sliderInit("slider", "value", function(v) { graph.recomputeGraph(v); /*graph.render();*/ });
    NER.nodeSlider.setConfig();

    // Bootstrap showing the slider value here (none of the callbacks in the
    // slider API help).
    d3.select("#value").html($("#slider").slider("value"));

    document.getElementById('docs').addEventListener('change', handleFileSelect, false);
};
